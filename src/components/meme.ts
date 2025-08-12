// src/components/meme.ts
// Dynamic Memegen inputs + Local canvas mode
// Watermark: dynamic (connected user), visible on preview overlay, burned into downloads.

import { CONFIG } from "./config"; // adjust if your config path differs

type TplRaw = {
  key?: string;
  id?: string;
  template?: string;
  slug?: string;
  name?: string;
  sample?: string;
  example?: { text?: string[]; url?: string };
};

type Template = {
  key: string;
  name: string;
  sample?: string;
  lines: number;
};

type Detail = {
  lines: number;
  example?: string[];
  blank?: string;
};

const PAGE_SIZE = 24;
const KNOWN_LINE_OVERRIDES: Record<string, number> = {
  gru: 4,
  "get-better-material": 4,
  crow: 4,
  "expanding-brain": 4,
  "tintin-and-snowy": 3,
};

// ---- Watermark state (can be set from main.ts) ----
let ACTIVE_WM = (CONFIG as any)?.OWNER_SOL_DOMAIN || "";

/** Public setter: call this from main.ts when wallet connects/changes */
export function setMemeWatermark(wm?: string) {
  ACTIVE_WM = (wm || "").trim();
  // Update preview overlay + hint immediately
  updatePreviewOverlayText();
  const hint = document.getElementById("api-watermark-hint");
  if (hint) hint.textContent = ACTIVE_WM ? `Watermark: ${ACTIVE_WM}` : "";
  // Repaint local canvas if it's visible
  _redrawLocalCanvas?.();
}

// ------- Memegen helpers -------
const memegen = {
  encode(s: string) {
    return s
      .trim()
      .replace(/_/g, "__")
      .replace(/-/g, "--")
      .replace(/ /g, "_")
      .replace(/\?/g, "~q")
      .replace(/%/g, "~p")
      .replace(/#/g, "~h")
      .replace(/\//g, "~s")
      .replace(/\\/g, "~b")
      .replace(/</g, "~l")
      .replace(/>/g, "~g");
  },

  normalizeLines(lines: string[]) {
    return (lines || []).map((v) => (v && v.trim() ? v : "_"));
  },

  inferLineCountFromSample(sample?: string): number {
    if (!sample) return 2;
    try {
      const clean = sample.split("?")[0];
      const m = clean.match(/\/images\/[^/]+\/(.+?)\.(?:png|jpg|jpeg|webp|gif)$/i);
      if (m && m[1]) {
        const count = m[1].split("/").filter(Boolean).length;
        return Math.max(1, count || 2);
      }
    } catch {}
    return 2;
  },

  async list(): Promise<Template[]> {
    let raw: TplRaw[] = [];
    try {
      const res = await fetch("https://api.memegen.link/templates/");
      if (!res.ok) throw new Error("Failed to load meme templates");
      raw = await res.json();
    } catch {
      raw = [
        { key: "fry", name: "Futurama Fry", example: { text: ["Not sure if", "or just"] } },
        { key: "drake", name: "Drake Hotline Bling", example: { text: ["No", "Yes"] } },
        { key: "gru", name: "Gru Plan", example: { text: ["1", "2", "3", "4"] } },
      ];
    }

    const list = raw
      .map((t) => {
        const key = (t.key || t.id || t.template || t.slug || "").toString();
        const name = (t.name || t.id || t.key || "Template").toString();
        const sampleUrl = t.example?.url || t.sample;
        const fromExample = Array.isArray(t.example?.text) ? t.example!.text!.length : 0;
        const fromSample = memegen.inferLineCountFromSample(sampleUrl);
        const override = KNOWN_LINE_OVERRIDES[key];
        const lines = override || fromExample || fromSample || 2;
        return key ? ({ key, name, sample: sampleUrl, lines } as Template) : null;
      })
      .filter(Boolean) as Template[];

    const seen = new Set<string>();
    return list.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
  },

  // per-template details + example, cached
  _detailCache: new Map<string, Detail>(),
  async details(tplKey: string): Promise<Detail> {
    const cached = this._detailCache.get(tplKey);
    if (cached) return cached;

    let lines = KNOWN_LINE_OVERRIDES[tplKey] || 0;
    let example: string[] | undefined;
    let blank: string | undefined;

    try {
      const res = await fetch(`https://api.memegen.link/templates/${encodeURIComponent(tplKey)}`);
      if (res.ok) {
        const j: any = await res.json();
        const fromExample = Array.isArray(j?.example?.text) ? j.example.text.length : 0;
        const fromUrl = memegen.inferLineCountFromSample(j?.example?.url || j?.blank);
        lines = Math.max(lines, fromExample || fromUrl || 0);
        if (Array.isArray(j?.example?.text)) example = j.example.text as string[];
        if (typeof j?.blank === "string") blank = j.blank;
      }
    } catch {}

    if (!lines || lines < 1) lines = 2;
    const out: Detail = { lines, example, blank };
    this._detailCache.set(tplKey, out);
    return out;
  },

  // Preview uses text[] and cache-buster; memegen adds its own PREVIEW mark
  previewUrl(tplKey: string, lines: string[]) {
    const u = new URL("https://api.memegen.link/images/preview.jpg");
    u.searchParams.set("template", tplKey);
    memegen.normalizeLines(lines).forEach((v) => u.searchParams.append("text[]", v));
    u.searchParams.set("font", "impact");
    u.searchParams.set("width", "600");
    // Their preview watermark may ignore ours; we overlay our own in the UI anyway.
    u.searchParams.set("cb", String(Date.now() % 1e9));
    return u.toString();
  },

  // Final PNG (for Open/Copy); our Download button post-processes to burn our WM
  finalUrl(tplKey: string, lines: string[]) {
    const parts = memegen.normalizeLines(lines).map((t) => (t === "_" ? "_" : memegen.encode(t)));
    const path = parts.join("/");
    const u = new URL(`https://api.memegen.link/images/${encodeURIComponent(tplKey)}/${path}.png`);
    u.searchParams.set("font", "impact");
    u.searchParams.set("width", "600");
    if ((CONFIG as any)?.MEMEGEN_API_KEY) {
      u.searchParams.set("api_key", (CONFIG as any).MEMEGEN_API_KEY);
    }
    // NOTE: not relying on server-side watermark here
    return u.toString();
  },
};

// ------- DOM helpers -------
const pick = <T extends HTMLElement = HTMLElement>(...ids: string[]) => {
  for (const id of ids) {
    const el = document.getElementById(id) as T | null;
    if (el) return el;
  }
  return null;
};
const on = <K extends keyof HTMLElementEventMap>(
  el: HTMLElement | null,
  ev: K,
  fn: (e: HTMLElementEventMap[K]) => any,
) => el?.addEventListener(ev, fn as any);

// Small escape util
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]!));

// ------- Local Canvas Mode -------
let _redrawLocalCanvas: (() => void) | null = null;

function initLocalCanvasMode() {
  const upload = pick<HTMLInputElement>("meme-upload");
  const topIn = pick<HTMLInputElement>("top-text");
  const botIn = pick<HTMLInputElement>("bottom-text");
  const canvas = pick<HTMLCanvasElement>("meme-canvas");
  const dlBtn = pick<HTMLButtonElement>("download-meme");
  const ctx = canvas?.getContext("2d") || null;

  if (!upload || !topIn || !botIn || !canvas || !ctx) return;

  let baseImg: HTMLImageElement | null = null;

  const fitCanvasToImage = (img: HTMLImageElement) => {
    const maxW = Math.min(1000, img.naturalWidth || 1000);
    const scale = img.naturalWidth ? maxW / img.naturalWidth : 1;
    canvas.width = Math.round((img.naturalWidth || 1000) * scale);
    canvas.height = Math.round((img.naturalHeight || 1000) * scale);
  };

  const drawWatermark = () => {
    if (!ACTIVE_WM) return;
    const pad = Math.max(8, Math.round(canvas.width * 0.02));
    const size = Math.max(12, Math.round(canvas.width / 32));
    const text = ACTIVE_WM;

    ctx.save();
    ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";

    // Measure text + draw pill background
    const metrics = ctx.measureText(text);
    const textW = metrics.width;
    const textH = size * 1.35;
    const boxW = textW + pad * 1.5;
    const boxH = textH + pad * 0.8;
    const x = canvas.width - pad;
    const y = canvas.height - pad;

    ctx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(ctx, x - boxW, y - boxH, boxW, boxH, Math.max(6, Math.round(size / 3)));
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.fillText(text, x - pad * 0.75, y - pad * 0.4);
    ctx.restore();
  };

  const drawTextBlock = (text: string, yPct: number) => {
    const pad = Math.max(8, Math.round(canvas.width * 0.02));
    const size = Math.max(18, Math.round(canvas.width / 10));
    ctx.font = `bold ${size}px Impact, Arial Black, Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(4, Math.round(size / 10));
    const textY = Math.round(canvas.height * yPct);
    ctx.strokeStyle = "black";
    ctx.fillStyle = "white";

    const words = (text || "").split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (ctx.measureText(test).width > canvas.width - 2 * pad) {
        if (cur) lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);

    const step = size + 6;
    let y = textY;
    for (const ln of lines) {
      const x = Math.round(canvas.width / 2);
      ctx.strokeText(ln, x, y);
      ctx.fillText(ln, x, y);
      y += step;
    }
  };

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (baseImg) ctx.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
    else {
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    drawTextBlock(topIn.value, 0.04);
    ctx.textBaseline = "bottom";
    drawTextBlock(botIn.value, 0.80);
    drawWatermark();
  };
  _redrawLocalCanvas = draw;

  on(upload, "change", () => {
    const file = upload.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      baseImg = img;
      fitCanvasToImage(img);
      draw();
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

  on(topIn, "input", draw);
  on(botIn, "input", draw);

  on(dlBtn, "click", () => {
    draw(); // ensure latest text + watermark
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = (ACTIVE_WM ? `${ACTIVE_WM}-` : "") + "meme.png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  // initial canvas
  fitCanvasToImage({ naturalWidth: 800, naturalHeight: 800 } as any);
  draw();
}

// ------- API Template Mode -------
let _apiGetLines: (() => string[]) | null = null;
let _apiSelectedId = "fry";
let _apiCurrentFinalUrl = "";

/** Create/ensure our on-image watermark overlay for API preview */
function ensurePreviewOverlay() {
  const card = (document.getElementById("api-preview") || document.getElementById("meme-preview"))?.parentElement;
  const img = document.getElementById("api-preview") || document.getElementById("meme-preview");
  if (!card || !img) return;

  // Make card a positioning context
  if (getComputedStyle(card).position === "static") (card as HTMLElement).style.position = "relative";

  // Overlay element
  let ov = document.getElementById("api-wm-overlay") as HTMLDivElement | null;
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "api-wm-overlay";
    ov.style.position = "absolute";
    ov.style.right = "10px";
    ov.style.bottom = "10px";
    ov.style.padding = "6px 10px";
    ov.style.borderRadius = "8px";
    ov.style.background = "rgba(0,0,0,0.45)";
    ov.style.color = "#fff";
    ov.style.font = "600 12px Inter, system-ui, sans-serif";
    ov.style.pointerEvents = "none";
    card.appendChild(ov);
  }
  updatePreviewOverlayText();
}
function updatePreviewOverlayText() {
  const ov = document.getElementById("api-wm-overlay");
  if (!ov) return;
  ov.textContent = ACTIVE_WM || "";
  ov.style.display = ACTIVE_WM ? "block" : "none";
}

async function initApiTemplateMode() {
  const apiMode = document.getElementById("api-mode");
  apiMode?.classList.remove("hidden");
  toggleLocalControls(false);

  const tray = pick<HTMLDivElement>("api-templates");
  let linesWrap = pick<HTMLDivElement>("api-lines");
  const preview = pick<HTMLImageElement>("meme-preview", "api-preview");
  const openBtn = pick<HTMLAnchorElement>("meme-open", "api-open");
  const copyBtn = pick<HTMLButtonElement>("meme-copy", "api-copy");
  const dlBtn = pick<HTMLButtonElement>("meme-download", "api-download");
  const search = pick<HTMLInputElement>("meme-search", "template-search");
  const prevBtn = pick<HTMLButtonElement>("meme-prev-page", "api-prev");
  const nextBtn = pick<HTMLButtonElement>("meme-next-page", "api-next");
  const pageSpan = pick<HTMLElement>("api-page");
  const pagesSpan = pick<HTMLElement>("api-pages");
  const wmHint = pick<HTMLElement>("api-watermark-hint");

  // Create #api-lines + example hint if missing
  let exampleHint = document.getElementById("api-example") as HTMLDivElement | null;
  if (!linesWrap) {
    const parent =
      document.getElementById("api-mode") || tray?.parentElement || document.body;
    linesWrap = document.createElement("div");
    linesWrap.id = "api-lines";
    linesWrap.className = "grid md:grid-cols-2 gap-2";

    exampleHint = document.createElement("div");
    exampleHint.id = "api-example";
    exampleHint.className = "text-xs text-white/70 italic mt-2";

    const previewCard = parent!.querySelector(".glass.rounded-lg.p-3");
    if (previewCard) {
      parent!.insertBefore(linesWrap, previewCard);
      parent!.insertBefore(exampleHint, previewCard);
    } else {
      parent!.appendChild(linesWrap);
      parent!.appendChild(exampleHint);
    }

    // Hide any legacy two-inputs if still present
    document.getElementById("api-top")?.classList.add("hidden");
    document.getElementById("api-bottom")?.classList.add("hidden");
  }

  if (!tray || !linesWrap || !preview || !openBtn) return;

  if (wmHint) wmHint.textContent = ACTIVE_WM ? `Watermark: ${ACTIVE_WM}` : "";

  let all = await memegen.list();
  let filtered = all.slice();
  let page = 1;

  let selectedLineCount: number = filtered[0]?.lines || 2;
  let currentExample: string[] | undefined;

  const getLines = () =>
    Array.from(linesWrap!.querySelectorAll<HTMLInputElement>("input.api-line")).map((i) => i.value);
  _apiGetLines = getLines;

  const updatePreview = (() => {
    let raf = 0;
    return () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const lines = getLines();
        const prev = memegen.previewUrl(_apiSelectedId, lines);
        const fin = memegen.finalUrl(_apiSelectedId, lines);
        preview.src = prev;
        openBtn.href = fin;
        _apiCurrentFinalUrl = fin;
      });
    };
  })();

  const setExampleHint = () => {
    if (!exampleHint) return;
    if (!currentExample?.length) {
      exampleHint.textContent = "";
      return;
    }
    const joined = currentExample.filter(Boolean).join(" • ");
    exampleHint.innerHTML =
      `<span class="opacity-80">Example:</span> ${escapeHtml(joined)} ` +
      `<button id="api-example-fill" class="ml-2 underline underline-offset-2 opacity-90 hover:opacity-100">Reset to example</button>`;
    const fillBtn = document.getElementById("api-example-fill");
    fillBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      const inputs = linesWrap!.querySelectorAll<HTMLInputElement>("input.api-line");
      inputs.forEach((inp, i) => (inp.value = currentExample![i] ?? ""));
      updatePreview();
    });
  };

  const buildLineInputs = (count: number, defaults?: string[]) => {
    selectedLineCount = Math.max(1, count | 0); // reset per template
    linesWrap!.innerHTML = "";
    for (let i = 0; i < selectedLineCount; i++) {
      const input = document.createElement("input");
      input.type = "text";
      input.className =
        "api-line w-full bg-transparent border border-white/10 rounded-lg px-3 py-2 text-sm focus-glow";
      input.placeholder = `Text ${i + 1}`;
      input.autocomplete = "off";
      input.spellcheck = false;
      if (defaults && typeof defaults[i] === "string") input.value = defaults[i] as string;
      input.addEventListener("input", updatePreview);
      linesWrap!.appendChild(input);
    }
    setExampleHint();
  };

  const renderPage = () => {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), totalPages);
    const start = (page - 1) * PAGE_SIZE;
    const items = filtered.slice(start, start + PAGE_SIZE);

    tray.innerHTML = items
      .map(
        (t) => `
      <button class="group relative block rounded-lg overflow-hidden border border-white/10 hover:border-white/30 transition"
              data-id="${t.key}" data-lines="${t.lines}" title="${t.name}">
        <img src="https://api.memegen.link/images/${encodeURIComponent(t.key)}.jpg?height=90"
             alt="${t.name}" loading="lazy"
             class="w-full h-20 object-cover group-hover:scale-105 transition" />
        <span class="absolute bottom-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/60">${t.name}</span>
      </button>`
      )
      .join("");

    tray.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        const btn = b as HTMLButtonElement;
        _apiSelectedId = btn.dataset.id || "fry";

        let n = parseInt(btn.dataset.lines || "2", 10);
        if (!Number.isFinite(n) || n < 1) n = 2;

        try {
          const det = await memegen.details(_apiSelectedId);
          if (det.lines > n) n = det.lines;
          currentExample = det.example;
        } catch {
          currentExample = undefined;
        }

        if (KNOWN_LINE_OVERRIDES[_apiSelectedId] && KNOWN_LINE_OVERRIDES[_apiSelectedId] > n) {
          n = KNOWN_LINE_OVERRIDES[_apiSelectedId];
        }

        buildLineInputs(n, currentExample);
        updatePreview();
        linesWrap!.querySelector<HTMLInputElement>("input.api-line")?.focus();
      })
    );

    if (pageSpan) pageSpan.textContent = String(page);
    if (pagesSpan) pagesSpan.textContent = String(totalPages);
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
  };

  on(search, "input", () => {
    const q = (search!.value || "").toLowerCase().trim();
    filtered = q
      ? all.filter((t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
      : all.slice();
    page = 1;
    renderPage();
  });
  on(prevBtn, "click", () => { page--; renderPage(); });
  on(nextBtn, "click", () => { page++; renderPage(); });

  renderPage();
  try {
    const det = await memegen.details(_apiSelectedId);
    if (det.lines) selectedLineCount = det.lines;
    currentExample = det.example;
  } catch { currentExample = undefined; }
  buildLineInputs(selectedLineCount || 2, currentExample);

  ensurePreviewOverlay();
  updatePreviewOverlayText();
  updatePreview();

  // Copy URL (server image, no custom WM)
  on(copyBtn, "click", async (e) => {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(_apiCurrentFinalUrl);
      (window as any)?.toast?.success?.("Copied image URL");
    } catch { (window as any)?.toast?.error?.("Failed to copy"); }
  });

  // Download with OUR watermark burned in
  on(dlBtn, "click", async (e) => {
    e.preventDefault();
    try {
      const url = _apiCurrentFinalUrl;
      const fileName = (_apiSelectedId || "meme") + ".png";
      await downloadWithWatermark(url, fileName, ACTIVE_WM);
    } catch { (window as any)?.toast?.error?.("Download failed"); }
  });
}

// ------- Mode Toggle Wiring (API vs Local) -------
function toggleLocalControls(show: boolean) {
  const localNodes = [
    pick("meme-upload"),
    pick("top-text"),
    pick("bottom-text"),
    pick("meme-canvas"),
    pick("download-meme"),
  ].filter(Boolean) as HTMLElement[];
  localNodes.forEach((n) => (n.style.display = show ? "" : "none"));
}

function initMemeModeToggles() {
  const apiMode = pick<HTMLDivElement>("api-mode");
  const modeApiBtn = pick<HTMLButtonElement>("mode-api");
  const modeLocalBtn = pick<HTMLButtonElement>("mode-local");

  const showApi = (on: boolean) => { if (apiMode) apiMode.style.display = on ? "" : "none"; };

  // Default: API visible, Local hidden
  showApi(true);
  toggleLocalControls(false);
  modeApiBtn?.classList.add("bg-white/10");
  modeLocalBtn?.classList.remove("bg-white/10");

  on(modeApiBtn, "click", () => {
    showApi(true);
    toggleLocalControls(false);
    modeApiBtn?.classList.add("bg-white/10");
    modeLocalBtn?.classList.remove("bg-white/10");
  });

  on(modeLocalBtn, "click", () => {
    showApi(false);
    toggleLocalControls(true);
    modeLocalBtn?.classList.add("bg-white/10");
    modeApiBtn?.classList.remove("bg-white/10");
  });
}

// ------- Utilities -------
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function downloadWithWatermark(url: string, name: string, wm: string) {
  // Draw remote image to canvas, add our watermark pill, download as PNG
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const cx = c.getContext("2d")!;
  cx.drawImage(img, 0, 0, c.width, c.height);

  if (wm) {
    const pad = Math.max(12, Math.round(c.width * 0.02));
    const size = Math.max(18, Math.round(c.width / 32));
    cx.save();
    cx.font = `600 ${size}px Inter, system-ui, sans-serif`;
    cx.textAlign = "right";
    cx.textBaseline = "bottom";
    const metrics = cx.measureText(wm);
    const textW = metrics.width;
    const textH = size * 1.35;
    const boxW = textW + pad * 1.5;
    const boxH = textH + pad * 0.8;
    const x = c.width - pad;
    const y = c.height - pad;

    cx.fillStyle = "rgba(0,0,0,0.45)";
    roundRect(cx, x - boxW, y - boxH, boxW, boxH, Math.max(8, Math.round(size / 2.5)));
    cx.fill();

    cx.fillStyle = "#fff";
    cx.fillText(wm, x - pad * 0.75, y - pad * 0.4);
    cx.restore();
  }

  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // needed for canvas export
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// ------- Public init -------
export async function initMemeGen() {
  initMemeModeToggles();
  initLocalCanvasMode();
  await initApiTemplateMode();
}

// Back-compat
export { initMemeGen as initMeme };
export default initMemeGen;
