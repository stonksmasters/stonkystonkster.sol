import { CONFIG } from "./config";
import { showToast } from "./toast";

// ---- Memegen helpers (preview uses lines[], final uses encoded path) ----
type TplRaw = { id?: string; key?: string; template?: string; slug?: string; name?: string };
type Template = { key: string; name: string };

const PAGE_SIZE = 30;

const memegen = {
  list: async (): Promise<Template[]> => {
    const res = await fetch("https://api.memegen.link/templates/");
    if (!res.ok) throw new Error("Failed to load templates");
    const raw: TplRaw[] = await res.json();
    return raw
      .map((t) => ({ key: (t.key || t.id || t.template || t.slug || "").toString(), name: (t.name || t.id || t.key || "Template").toString() }))
      .filter((t) => t.key); // drop empties
  },
  encode: (s: string) =>
    s.trim()
      .replace(/_/g, "__")
      .replace(/-/g, "--")
      .replace(/ /g, "_")
      .replace(/\?/g, "~q")
      .replace(/%/g, "~p")
      .replace(/#/g, "~h")
      .replace(/\//g, "~s")
      .replace(/\\/g, "~b")
      .replace(/"/g, "''"),
  previewUrl: (tplKey: string, top: string, bottom: string) => {
    const u = new URL("https://api.memegen.link/images/preview.jpg");
    u.searchParams.set("template", tplKey);
    if (top) u.searchParams.append("lines[]", top);
    if (bottom) u.searchParams.append("lines[]", bottom);
    u.searchParams.set("font", "impact");
    u.searchParams.set("width", "600");
    return u.toString();
  },
  finalUrl: (tplKey: string, top: string, bottom: string) => {
    const topSlug = top ? memegen.encode(top) : "_";
    const botSlug = bottom ? memegen.encode(bottom) : "_";
    const base = `https://api.memegen.link/images/${encodeURIComponent(tplKey)}/${topSlug}/${botSlug}.png`;
    const u = new URL(base);
    u.searchParams.set("font", "impact");
    u.searchParams.set("width", "600");
    if (CONFIG.MEMEGEN_API_KEY) {
      u.searchParams.set("api_key", CONFIG.MEMEGEN_API_KEY);
      u.searchParams.set("watermark", CONFIG.OWNER_SOL_DOMAIN);
    }
    return u.toString();
  }
};

// ---- Local Canvas Mode (unchanged) ----
function initLocalCanvasMode() {
  const canvas = document.getElementById("meme-canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const topText = document.getElementById("top-text") as HTMLInputElement;
  const bottomText = document.getElementById("bottom-text") as HTMLInputElement;
  const imgUpload = document.getElementById("meme-upload") as HTMLInputElement;
  const downloadBtn = document.getElementById("download-meme") as HTMLButtonElement;

  let image: HTMLImageElement | null = null;

  imgUpload.onchange = e => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      image = new Image();
      image.onload = draw;
      image.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  [topText, bottomText].forEach(inp => inp.oninput = draw);

  downloadBtn.onclick = () => {
    if (!image) return showToast("Pick a template or upload an image first", "error");
    const a = document.createElement("a");
    a.download = `${CONFIG.OWNER_SOL_DOMAIN}-meme.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    showToast("Meme downloaded!", "success");
  };

  function draw() {
    if (image && image.complete) ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    else { ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, canvas.width, canvas.height); }

    ctx.textAlign = "center";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "black";
    ctx.fillStyle = "white";
    ctx.font = "48px Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif";
    ctx.lineWidth = 6;

    const t = topText.value?.toUpperCase();
    const b = bottomText.value?.toUpperCase();
    if (t) { ctx.strokeText(t, canvas.width/2, 60); ctx.fillText(t, canvas.width/2, 60); }
    if (b) { ctx.strokeText(b, canvas.width/2, canvas.height-24); ctx.fillText(b, canvas.width/2, canvas.height-24); }

    // SNS watermark
    ctx.save();
    ctx.font = "18px Inter, system-ui, sans-serif";
    ctx.globalAlpha = 0.9;
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 3;
    ctx.strokeText(CONFIG.OWNER_SOL_DOMAIN, canvas.width - 12, canvas.height - 12);
    ctx.fillText(CONFIG.OWNER_SOL_DOMAIN, canvas.width - 12, canvas.height - 12);
    ctx.restore();
  }
}

// ---- API Templates Mode (pagination + SNS-watermark download) ----
async function initApiMode() {
  const tray = document.getElementById("api-templates") as HTMLDivElement;
  const search = document.getElementById("template-search") as HTMLInputElement;
  const pageEl = document.getElementById("api-page") as HTMLSpanElement;
  const pagesEl = document.getElementById("api-pages") as HTMLSpanElement;
  const prevBtn = document.getElementById("api-prev") as HTMLButtonElement;
  const nextBtn = document.getElementById("api-next") as HTMLButtonElement;

  const top = document.getElementById("api-top") as HTMLInputElement;
  const bottom = document.getElementById("api-bottom") as HTMLInputElement;
  const preview = document.getElementById("api-preview") as HTMLImageElement;
  const openBtn = document.getElementById("api-open") as HTMLAnchorElement;
  const copyBtn = document.getElementById("api-copy") as HTMLButtonElement;
  const dlBtn = document.getElementById("api-download") as HTMLButtonElement;
  const hint = document.getElementById("api-watermark-hint") as HTMLDivElement;

  if (CONFIG.MEMEGEN_API_KEY) {
    hint.textContent = `Server-side watermark enabled for: ${CONFIG.OWNER_SOL_DOMAIN}`;
  } else {
    hint.innerHTML = `No API key set — use <b>Download (SNS watermark)</b> to bake <b>${CONFIG.OWNER_SOL_DOMAIN}</b> locally.`;
  }

  let all: Template[] = [];
  try { all = await memegen.list(); }
  catch { tray.innerHTML = `<div class="text-sm text-red-300">Failed to load templates</div>`; return; }

  let filtered = all;
  let page = 1;
  let selectedId = (all[0]?.key) || "fry";

  const totalPages = () => Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const setPage = (p: number) => {
    page = Math.min(Math.max(1, p), totalPages());
    pageEl.textContent = String(page);
    pagesEl.textContent = String(totalPages());
    prevBtn.disabled = page === 1;
    nextBtn.disabled = page === totalPages();
    renderPage();
  };

  const renderPage = () => {
    const start = (page - 1) * PAGE_SIZE;
    const items = filtered.slice(start, start + PAGE_SIZE);
    tray.innerHTML = items.map(t => `
      <button class="group relative block rounded-lg overflow-hidden border border-white/10 hover:border-white/30 transition"
              data-id="${t.key}" title="${t.name}">
        <img src="https://api.memegen.link/images/${encodeURIComponent(t.key)}.jpg?height=90"
             class="w-full h-20 object-cover group-hover:scale-105 transition" />
        <span class="absolute bottom-1 left-1 text-[10px] px-1.5 py-0.5 rounded bg-black/60">${t.name}</span>
      </button>
    `).join("");

    tray.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      selectedId = (b as HTMLButtonElement).dataset.id || "fry";
      updatePreview();
    }));
  };

  const updatePreview = () => {
    const urlPrev = memegen.previewUrl(selectedId || "fry", top.value || "", bottom.value || "");
    const urlFinal = memegen.finalUrl(selectedId || "fry", top.value || "", bottom.value || "");
    preview.src = urlPrev;    // live preview (shows text)
    openBtn.href = urlFinal;  // final image
  };

  // Search + pagination + input listeners
  search.oninput = () => {
    const q = search.value.toLowerCase().trim();
    filtered = q ? all.filter(t => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q)) : all;
    setPage(1);
  };
  prevBtn.onclick = () => setPage(page - 1);
  nextBtn.onclick = () => setPage(page + 1);
  [top, bottom].forEach(el => el.addEventListener("input", updatePreview));

  copyBtn.onclick = async () => {
    if (!openBtn.href) return;
    await navigator.clipboard.writeText(openBtn.href);
    showToast("Meme URL copied", "success");
  };

  dlBtn.onclick = async () => {
    if (!openBtn.href) return;
    try {
      const img = await loadImage(openBtn.href);
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      const c = canvas.getContext("2d")!;
      c.drawImage(img, 0, 0);
      // SNS watermark
      c.save();
      c.font = `${Math.max(18, Math.floor(canvas.width * 0.02))}px Inter, system-ui, sans-serif`;
      c.textAlign = "right";
      c.fillStyle = "rgba(255,255,255,0.95)";
      c.strokeStyle = "rgba(0,0,0,0.5)";
      c.lineWidth = Math.max(2, Math.floor(canvas.width * 0.0025));
      const pad = Math.max(12, Math.floor(canvas.width * 0.02));
      c.strokeText(CONFIG.OWNER_SOL_DOMAIN, canvas.width - pad, canvas.height - pad);
      c.fillText(CONFIG.OWNER_SOL_DOMAIN, canvas.width - pad, canvas.height - pad);
      c.restore();
      const a = document.createElement("a");
      a.download = `${CONFIG.OWNER_SOL_DOMAIN}-meme.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
      showToast("Meme downloaded with watermark!", "success");
    } catch { showToast("Failed to download image", "error"); }
  };

  function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  setPage(1);
  updatePreview();
}

// ---- Mode toggle (default to API mode) ----
function initModeToggle() {
  const apiMode = document.getElementById("api-mode")!;
  const localInputs = [
    document.getElementById("meme-upload"),
    document.getElementById("top-text"),
    document.getElementById("bottom-text"),
    document.getElementById("meme-canvas"),
    document.getElementById("download-meme")
  ].filter(Boolean) as HTMLElement[];

  const apiBtn = document.getElementById("mode-api")!;
  const localBtn = document.getElementById("mode-local")!;

  const showApi = () => {
    apiMode.classList.remove("hidden");
    localInputs.forEach(el => el?.classList.add("hidden"));
    apiBtn.classList.add("bg-white/15");
    localBtn.classList.remove("bg-white/15");
  };
  const showLocal = () => {
    apiMode.classList.add("hidden");
    localInputs.forEach(el => el?.classList.remove("hidden"));
    localBtn.classList.add("bg-white/15");
    apiBtn.classList.remove("bg-white/15");
  };

  apiBtn.addEventListener("click", showApi);
  localBtn.addEventListener("click", showLocal);
  showApi();
}

export const initMemeGen = () => {
  initLocalCanvasMode();
  initApiMode().catch(() => showToast("Memegen API failed", "error"));
  initModeToggle();
};
