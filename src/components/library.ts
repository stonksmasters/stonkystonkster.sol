// src/components/library.ts
// Local per-wallet library for downloaded memes. No backend.

type MemeRecord = {
  id: string;                 // sha256 of (tpl|lines|wm|src-type)
  tpl?: string;               // memegen template key
  lines?: string[];           // text lines
  wm: string;                 // watermark label
  creator: string;            // creator pubkey
  createdAt: number;          // epoch ms
  source: "api" | "upload";   // creation path
  finalUrl?: string;          // server image (api)
  dataUrl?: string;           // baked image (upload)
  thumb?: string;             // small preview
};

const MAX_ITEMS = 100;

async function sha256Hex(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const out = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(out)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function makeId(p: Pick<MemeRecord,"tpl"|"lines"|"wm"|"finalUrl"|"source">) {
  const base = JSON.stringify({
    t: p.tpl || "", l: p.lines || [], w: p.wm || "", s: p.source, f: (p.finalUrl || "").split("?")[0],
  });
  return sha256Hex(base);
}
const storeKey = (pk: string | null) => `stonky:lib:${pk || "anon"}`;
const loadAll = (pk: string | null): MemeRecord[] => {
  try { return JSON.parse(localStorage.getItem(storeKey(pk)) || "[]"); } catch { return []; }
};
const saveAll = (pk: string | null, rows: MemeRecord[]) => {
  try { localStorage.setItem(storeKey(pk), JSON.stringify(rows.slice(0, MAX_ITEMS))); } catch {}
};

let CUR_PK: string | null = null;
let CUR_LABEL: string | null = null;

function ensureSection(): HTMLElement {
  let sec = document.getElementById("my-memes");
  if (sec) return sec;
  const host = document.getElementById("meme") || document.body;
  sec = document.createElement("section");
  sec.id = "my-memes";
  sec.className = "mt-4 rounded-lg border border-white/10 p-3 bg-white/5";
  sec.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <h4 class="text-sm font-semibold">🗂 My Memes</h4>
      <div id="lib-owner" class="text-xs text-white/60"></div>
    </div>
    <div id="my-memes-grid" class="grid grid-cols-2 md:grid-cols-3 gap-2"></div>
    <div id="my-memes-empty" class="text-xs text-white/60 py-6 text-center hidden">No memes yet — make one!</div>`;
  host.appendChild(sec);
  return sec;
}
const short = (pk: string) => (pk && pk.length > 10 ? `${pk.slice(0,4)}…${pk.slice(-4)}` : pk);

function render() {
  ensureSection();
  const head = document.getElementById("lib-owner")!;
  head.textContent = CUR_LABEL ? `for ${CUR_LABEL}` : "";

  const grid = document.getElementById("my-memes-grid")!;
  const empty = document.getElementById("my-memes-empty")!;
  const rows = loadAll(CUR_PK);

  if (!rows.length) { grid.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");

  grid.innerHTML = rows.map((r) => {
    const when = new Date(r.createdAt).toLocaleString();
    const src = r.dataUrl || r.thumb || (r.finalUrl ? `${r.finalUrl}&width=240` : "");
    const img = src
      ? `<img src="${src}" alt="${r.tpl || "upload"}" class="w-full h-28 object-cover rounded border border-white/10" />`
      : `<div class="w-full h-28 rounded bg-white/10 border border-white/10"></div>`;
    return `
      <div class="rounded-lg p-2 bg-black/20 border border-white/10">
        ${img}
        <div class="mt-2 flex items-center justify-between text-[11px] text-white/70">
          <span>${r.tpl || "upload"}</span><span>${short(r.creator)}</span>
        </div>
        <div class="mt-1 text-[10px] text-white/50">${when}</div>
        <div class="mt-2 flex gap-1">
          <button data-act="open" data-id="${r.id}" class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs">Open</button>
          <button data-act="download" data-id="${r.id}" class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs">Download</button>
          <button data-act="like" data-id="${r.id}" class="px-2 py-1 rounded bg-white/10 border border-white/10 text-xs">Like</button>
        </div>
      </div>`;
  }).join("");

  grid.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id!;
      const act = btn.dataset.act!;
      const rec = loadAll(CUR_PK).find(r => r.id === id);
      if (!rec) return;

      if (act === "open") {
        window.dispatchEvent(new CustomEvent("stonky:openMeme", { detail: { tpl: rec.tpl, lines: rec.lines }}));
        (window as any)?.toast?.success?.("Loaded into editor");
      } else if (act === "download") {
        window.dispatchEvent(new CustomEvent("stonky:downloadMeme", { detail: rec }));
      } else if (act === "like") {
        if (!rec.creator) return;
        const url = new URL(`solana:${rec.creator}`);
        url.searchParams.set("amount", String(0.0001));
        url.searchParams.set("label", "Like this meme");
        url.searchParams.set("message", "Thanks for the meme!");
        url.searchParams.set("memo", `LIKE:${rec.id}`);
        window.open(url.toString(), "_blank");
      }
    });
  });
}

async function addRecord(rec: Omit<MemeRecord, "id" | "createdAt">) {
  const id = await makeId({ tpl: rec.tpl, lines: rec.lines, wm: rec.wm, finalUrl: rec.finalUrl, source: rec.source });
  const row: MemeRecord = { ...rec, id, createdAt: Date.now() };
  const cur = loadAll(CUR_PK);
  const next = [row, ...cur.filter((r) => r.id !== id)];
  saveAll(CUR_PK, next);
}

// ---- Public init ----
export function initMemeLibrary() {
  ensureSection();
  render();

  window.addEventListener("stonky:walletChanged", (e: any) => {
    CUR_PK = e?.detail?.pubkey || null;
    CUR_LABEL = e?.detail?.label || null;
    render();
  });

  window.addEventListener("stonky:recordMeme", async (e: any) => {
    const d = e?.detail;
    if (!d) return;
    await addRecord({
      tpl: d.tpl,
      lines: d.lines,
      wm: d.wm,
      creator: d.creator || (CUR_PK || ""),
      source: d.source || "api",
      finalUrl: d.finalUrl,
      dataUrl: d.dataUrl,
      thumb: d.thumb,
    });
    render();
  });
}
