// netlify/functions/fetchMemes.ts
import type { Handler } from '@netlify/functions';
import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

type PublishPayload = { v: 1; t: 'api'; k: string; l: string[]; wm?: string; c: string };
type FeedItem = { sig: string; slot: number; time: number; p: PublishPayload };

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

// -------- env / config --------
const OWNER_WALLET = mustPk(process.env.OWNER_WALLET);
const REGISTRY_FALLBACK = process.env.PUBLISH_REGISTRY ? mustPk(process.env.PUBLISH_REGISTRY) : OWNER_WALLET;
const RPCS = [
  ...(process.env.RPC_MAINNET ? [process.env.RPC_MAINNET] : []),
  ...((process.env.RPC_FALLBACKS || '').split(',').map(s => s.trim()).filter(Boolean)),
] as string[];

const PAGE_LIMIT_MAX = 32;
const DEFAULT_LIMIT = 12;
const TX_BATCH = 10;           // max signatures to fetch per batch
const MIN_CALL_SPACING = 150;  // ms between RPC calls in this invocation

// -------- utils --------
function mustPk(s?: string): PublicKey {
  if (!s) throw new Error('Missing required env var');
  return new PublicKey(s);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const withTimeout = <T,>(p: Promise<T>, ms = 8000) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function is429(e: unknown) {
  const msg = String((e as any)?.message || e || '');
  const code = (e as any)?.code ?? (e as any)?.error?.code;
  return msg.includes('Too many requests') || msg.includes('429') || code === -32429;
}

// extract Memo string (parsed/base64/log fallback)
function tryDecodeUtf8ThenBase64(data: string): string | null {
  try { return Buffer.from(data, 'utf8').toString('utf8'); } catch {}
  try { return Buffer.from(data, 'base64').toString('utf8'); } catch {}
  return null;
}
function extractMemoFromTx(tx: any): string {
  if (!tx) return '';
  const msg = tx?.transaction?.message;
  const ixs = msg?.instructions || [];
  const isMemoId = (pid: string) => { try { return new PublicKey(pid).equals(MEMO_PROGRAM_ID); } catch { return false; } };

  for (const i of ixs) {
    if (i?.programId && isMemoId(i.programId)) {
      if (typeof i?.parsed?.memo === 'string') return i.parsed.memo;
      if (typeof i?.data === 'string') { const s = tryDecodeUtf8ThenBase64(i.data); if (s != null) return s; }
    }
    if (typeof i?.programIdIndex === 'number' && Array.isArray(msg?.accountKeys)) {
      const programId = msg.accountKeys[i.programIdIndex];
      if (programId && isMemoId(programId)) {
        if (typeof i?.data === 'string') { const s = tryDecodeUtf8ThenBase64(i.data); if (s != null) return s; }
      }
    }
  }
  const metaMemo = (tx.meta as any)?.memo;
  if (metaMemo) return String(metaMemo);
  const logs: string[] = (tx.meta as any)?.logMessages || [];
  const lastLog = logs.filter((m: string) => m?.startsWith('Program log: ')).pop();
  if (lastLog) return lastLog.slice('Program log: '.length);
  return '';
}
function safeJson<T = any>(s: string): T | null { try { return JSON.parse(s); } catch { return null; } }

// -------- simple RPC pool w/ cooldown --------
type Ep = { url: string; cooldownUntil: number; fail: number };
const pool: Ep[] = (RPCS.length ? RPCS : ['https://api.mainnet-beta.solana.com'])
  .map((url) => ({ url, cooldownUntil: 0, fail: 0 }));

let lastCallAt = 0;
async function rateLimitPause() {
  const d = Date.now() - lastCallAt;
  if (d < MIN_CALL_SPACING) await sleep(MIN_CALL_SPACING - d);
  lastCallAt = Date.now();
}
async function pickConn(): Promise<Connection> {
  const now = Date.now();
  const order = [...pool].sort((a, b) => (a.cooldownUntil - b.cooldownUntil) || (a.fail - b.fail));
  for (const ep of order) {
    if (ep.cooldownUntil > now) continue;
    const c = new Connection(ep.url, { commitment: 'confirmed' });
    try {
      await withTimeout(c.getLatestBlockhash('finalized'), 5000);
      return c;
    } catch {
      ep.fail++; ep.cooldownUntil = now + Math.min(30000, 3000 * ep.fail);
    }
  }
  throw new Error('No RPC available');
}
function penalize(url: string, attempt = 1) {
  const ep = pool.find(p => p.url === url);
  if (!ep) return 500 * attempt;
  ep.fail++;
  ep.cooldownUntil = Date.now() + Math.min(60000, 1000 * Math.pow(2, Math.min(5, ep.fail)));
  return 500 * attempt;
}

// -------- cursor codec (per-registry "before" map) --------
type Cursor = Record<string, string | undefined>;
function encodeCursor(cur: Cursor): string {
  return Buffer.from(JSON.stringify(cur)).toString('base64url');
}
function decodeCursor(tok?: string | null): Cursor {
  if (!tok) return {};
  try { return JSON.parse(Buffer.from(tok, 'base64url').toString('utf8')); } catch { return {}; }
}

// -------- main: build one page --------
async function buildPage(limit: number, cursor: Cursor) {
  // registries: prefer explicit env registry, else OWNER
  const registries: PublicKey[] = [REGISTRY_FALLBACK];

  // 1) gather recent signatures per registry (small slice each)
  const conn = await pickConn();
  const perReg = Math.max(4, Math.ceil(limit / registries.length)); // small, spreads load
  type Row = { sig: string; slot: number; blockTime: number; reg: string };
  let merged: Row[] = [];

  for (const r of registries) {
    let tries = 0;
    for (;;) {
      await rateLimitPause();
      try {
        const before = cursor[r.toBase58()];
        const sigs = await withTimeout(
          conn.getSignaturesForAddress(
            r,
            before ? { before, limit: perReg } : { limit: perReg }
          ),
          6500
        );
        merged.push(...sigs.map(s => ({
          sig: s.signature, slot: s.slot ?? 0, blockTime: s.blockTime || 0, reg: r.toBase58()
        })));
        break;
      } catch (e: any) {
        if (is429(e) && tries < 3) {
          tries++;
          await sleep(penalize((conn as any)._rpcEndpoint, tries));
          continue;
        }
        throw e;
      }
    }
  }
  if (!merged.length) return { items: [] as FeedItem[], nextCursor: encodeCursor(cursor) };

  // newest first; pick top N unique
  merged.sort((a, b) => b.slot - a.slot);
  const seen = new Set<string>();
  const selected: Row[] = [];
  for (const row of merged) {
    if (seen.has(row.sig)) continue;
    seen.add(row.sig);
    selected.push(row);
    if (selected.length >= limit) break;
  }

  // 2) fetch parsed txs in small batches
  const items: FeedItem[] = [];
  const lastPerReg: Cursor = { ...cursor };

  for (let i = 0; i < selected.length; i += TX_BATCH) {
    const batch = selected.slice(i, i + TX_BATCH);
    let tries = 0;
    for (;;) {
      await rateLimitPause();
      try {
        const txs = await withTimeout(
          conn.getParsedTransactions(batch.map(b => b.sig), { maxSupportedTransactionVersion: 0 }),
          9000
        );

        txs?.forEach((tx, j) => {
          const row = batch[j];
          if (!row) return;
          lastPerReg[row.reg] = row.sig; // advance cursor even if not a meme

          if (!tx) return;
          const memoStr = extractMemoFromTx(tx);
          const m = safeJson(memoStr);
          if (m?.t === 'api' && typeof m.k === 'string' && Array.isArray(m.l)) {
            items.push({
              sig: row.sig,
              slot: tx.slot,
              time: (tx.blockTime || 0) * 1000,
              p: m as PublishPayload,
            });
          }
        });

        break;
      } catch (e: any) {
        if (is429(e) && tries < 3) {
          tries++;
          await sleep(penalize((conn as any)._rpcEndpoint, tries));
          continue;
        }
        throw e;
      }
    }
  }

  items.sort((a, b) => b.slot - a.slot);
  return { items, nextCursor: encodeCursor(lastPerReg) };
}

// -------- handler --------
export const handler: Handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const limit = Math.max(
      1,
      Math.min(
        PAGE_LIMIT_MAX,
        parseInt(q.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT
      )
    );
    const cursor = decodeCursor(q.cursor);

    const { items, nextCursor } = await buildPage(limit, cursor);

    return {
      statusCode: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control':
          'public, max-age=0, s-maxage=10, stale-while-revalidate=30',
      },
      body: JSON.stringify({ items, nextCursor }),
    };
  } catch (e: any) {
    const msg = String(e?.message || e || 'error');
    return {
      statusCode: is429(e) ? 429 : 500,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=0, s-maxage=5', // 👈 add here too
      },
      body: JSON.stringify({ error: msg }),
    };
  }
};
