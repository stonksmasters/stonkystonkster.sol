// Build /public/feed paged JSON from registry memos.
// Requires env: HELIUS, REGISTRY
import fs from 'node:fs/promises';
import path from 'node:path';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS = process.env.HELIUS;
const REGISTRY = new PublicKey(process.env.REGISTRY);

const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;
const conn = new Connection(RPC, 'confirmed');

const ROOT = 'public/feed';
const PAGES = path.join(ROOT, 'pages');
const PAGE_SIZE = 200;
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

await fs.mkdir(PAGES, { recursive: true });

// Load index (or init)
const indexPath = path.join(ROOT, 'index.json');
let index = { updated: 0, latestPage: 0, pageSize: PAGE_SIZE, pages: [], cursor: null };
try { index = { ...index, ...JSON.parse(await fs.readFile(indexPath, 'utf8')) }; } catch {}

// Helpers
const pageFile = (n) => path.join(PAGES, `page-${String(n).padStart(4, '0')}.json`);
const readPage = async (n) => JSON.parse(await fs.readFile(pageFile(n), 'utf8')).items || [];
const writePage = async (n, items) =>
  fs.writeFile(pageFile(n), JSON.stringify({ n, items }, null, 0));

const latestPageNum = index.latestPage || 1;
let currentItems = [];
try { currentItems = await readPage(latestPageNum); } catch { /* first run */ }

// 1) Pull new signatures since cursor (cap pages to be kind to Helius)
const MAX_BATCHES = 5; // up to ~500 tx/run
let before = undefined;
let newSigs = [];
let foundCursor = false;

for (let i = 0; i < MAX_BATCHES; i++) {
  const sigs = await conn.getSignaturesForAddress(REGISTRY, { before, limit: 100 });
  if (!sigs.length) break;
  for (const s of sigs) {
    if (index.cursor && s.signature === index.cursor) { foundCursor = true; break; }
    newSigs.push(s);
  }
  if (foundCursor) break;
  before = sigs.at(-1).signature;
}

// 2) Parse transactions (oldest first for append order)
newSigs = newSigs.reverse();
const events = [];
for (const s of newSigs) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (!tx) continue;

  const msg = tx.transaction.message;
  const keys = 'staticAccountKeys' in msg ? msg.staticAccountKeys : msg.accountKeys;
  const keyStrs = keys.map(k => k.toBase58 ? k.toBase58() : k.toString());

  const instrs = msg.instructions || []; // legacy
  const v0Instrs = msg.compiledInstructions || []; // v0
  // Normalize to {programId, data}
  const normalized = (v0Instrs.length ? v0Instrs.map(ix => ({
      programId: keyStrs[ix.programIdIndex],
      data: ix.data
    })) : instrs.map(ix => ({
      programId: ix.programId.toBase58 ? ix.programId.toBase58() : keys[ix.programIdIndex].toBase58(),
      data: ix.data
    }))
  );

  const decode = (d) => {
    try { return Buffer.from(d, 'base64').toString('utf8'); } catch {}
    try { return Buffer.from(bs58.decode(d)).toString('utf8'); } catch {}
    return null;
  };

  for (const ix of normalized) {
    if (ix.programId !== MEMO_PROGRAM) continue;
    const memoStr = decode(ix.data);
    if (!memoStr) continue;
    try {
      const j = JSON.parse(memoStr);
      if (j.v !== 1) continue;
      if (j.t !== 'post' && j.t !== 'like') continue;

      // enrich with ts/slot/sig
      const ev = { type: j.t, ...j, sig: s.signature, slot: s.slot, ts: tx.blockTime || 0 };

      // For likes, try to detect tip size to 'to' (author)
      if (j.t === 'like' && j.to) {
        const toIdx = keyStrs.indexOf(j.to);
        if (toIdx >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
          const delta = (tx.meta.postBalances[toIdx] || 0) - (tx.meta.preBalances[toIdx] || 0);
          if (delta > 0) ev.tipLamports = delta;
        }
      }

      events.push(ev);
    } catch { /* ignore non-json memos */ }
  }
}

// 3) Append events to pages
let pageNum = index.latestPage || 1;
let pageItems = currentItems;

for (const ev of events) {
  pageItems.push(ev);
  if (pageItems.length >= PAGE_SIZE) {
    await writePage(pageNum, pageItems);
    const fromSig = pageItems[0]?.sig || null;
    const toSig = pageItems.at(-1)?.sig || null;
    index.pages = index.pages.filter(p => p.n !== pageNum).concat([{ n: pageNum, path: `/feed/pages/page-${String(pageNum).padStart(4,'0')}.json`, fromSig, toSig }]);
    pageNum += 1;
    pageItems = [];
  }
}
// write last (possibly partial) page
await writePage(pageNum, pageItems);

// 4) Aggregate like counts / tip sums per CID (simple full scan for now)
const tally = new Map(); // cid -> {likes, tips}
const list = await fs.readdir(PAGES);
for (const f of list.sort()) {
  if (!f.endsWith('.json')) continue;
  const pg = JSON.parse(await fs.readFile(path.join(PAGES, f), 'utf8'));
  for (const it of (pg.items || [])) {
    if (it.type === 'like' && it.cid) {
      const cur = tally.get(it.cid) || { likes: 0, tipLamports: 0 };
      cur.likes += 1;
      if (it.tipLamports) cur.tipLamports += it.tipLamports;
      tally.set(it.cid, cur);
    }
  }
}
// decorate latest page's posts with tallies
const decorate = (items) => items.map(it => {
  if (it.type !== 'post' || !it.cid) return it;
  const t = tally.get(it.cid) || { likes: 0, tipLamports: 0 };
  return { ...it, likes: t.likes, tipLamports: t.tipLamports };
});
const latestDecorated = decorate(pageItems);
await writePage(pageNum, latestDecorated);

// 5) Update index cursor + metadata
index.latestPage = pageNum;
index.pageSize = PAGE_SIZE;
index.updated = Date.now();
if (newSigs.length) index.cursor = newSigs.at(-1).signature;

await fs.writeFile(indexPath, JSON.stringify(index, null, 0));
console.log('feed updated →', { latestPage: index.latestPage, added: events.length, cursor: index.cursor });
