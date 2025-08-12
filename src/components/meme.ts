// /src/meme.ts (or /meme.ts depending on your setup)
import { CONFIG } from "./config";

/**
 * Minimal types for the Memegen template list
 */
type TplRaw = {
  key?: string;           // canonical template id
  id?: string;            // some mirrors use id
  template?: string;      // alt name
  slug?: string;          // alt name
  name?: string;          // human label
  sample?: string;        // sample image url (encodes number of lines)
};

type Template = {
  key: string;
  name: string;
  sample?: string;
  lines: number;          // inferred number of text segments
};

const PAGE_SIZE = 24;

/**
 * Tiny memegen helper
 */
const memegen = {
  /**
   * Count how many text segments are in a sample url like:
   *   https://api.memegen.link/images/fry/YOUR_TEXT/GOES_HERE.png
   */
  inferLineCountFromSample(sample?: string): number {
    if (!sample) return 2;
    try {
      // strip query if present
      const clean = sample.split("?")[0];
      // capture everything between /images/{key}/ and extension
      const m = clean.match(/\/images\/[^/]+\/(.+?)\.(?:png|jpg|jpeg|webp|gif)$/i);
      if (m && m[1]) {
        // split by "/" to get segments; ignore empties just in case
        const count = m[1].split("/").filter(Boolean).length;
        return Math.max(1, count || 2);
      }
    } catch (_) { /* ignore */ }
    return 2;
  },

  async list(): Promise<Template[]> {
    const res = await fetch("https://api.memegen.link/templates/");
    if (!res.ok) throw new Error("Failed to load meme templates");
    const raw: TplRaw[] = await res.json();

    const list = raw
      .map((t) => {
        const key = (t.key || t.id || t.template || t.slug || "").toString();
        const name = (t.name || t.id || t.key || "Template").toString();
        const sample = t.sample;
        const lines = memegen.inferLineCountFromSample(sample);
        return key ? { key, name, sample, lines } as Template : null;
      })
      .filter(Boolean) as Template[];

    // Deduplicate by key just in case
    const seen = new Set<string>();
    return list.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));
  },

  // Memegen path-safe encoding rules
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

  /**
   * Live preview url (uses preview endpoint + line[] params)
   */
  previewUrl(tplKey: string, lines: string[]) {
    const u = new URL("https://api.memegen.link/images/preview.jpg");
    u.searchParams.set("template", tplKey);
    lines.forEach((v) => u.searchParams.append("line[]", v || "_"));
    // Optional cosmetics — keep aligned with your UI
    u.searchParams.set("font", "impact");
    u.searchParams.set("width", "600");
    return u.toString();
  },

  /**
   * Final image url (direct image path with encoded segments)
   */
  finalUrl(tplKey: string, lines: string[]) {
    const parts = (lines && lines.length ? lines : [""]).map((t) => memegen.encode(t || ""));
    const path = parts.length ? parts.join("/") : "_";
    const u = new URL(`https://api.memegen.link/images/${encodeURIComponent(tplKey)}/${path}.png`);
    u.searchParams.set("font", "impact");
    u.searchParams.set("width", "600");
    if ((CONFIG as any)?.MEMEGEN_API_KEY) {
      u.searchParams.set("api_key", (CONFIG as any).MEMEGEN_API_KEY);
    }
    if ((CONFIG as any)?.OWNER_SOL_DOMAIN) {
      // Optional watermark with your .sol
      u.searchParams.set("watermark", (CONFIG as any).OWNER_SOL_DOMAIN);
    }
    return u.toString();
  },
};

/**
 * DOM helpers with type narrowing
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T | null;

function on<K extends keyof HTMLElementEventMap>(
  el: HTMLElement | null,
  ev: K,
  fn: (e: HTMLElementEventMap[K]) => any,
) {
  el?.addEventListener(ev, fn as any);
}

/**
 * Initialize the API-template meme builder with dynamic text inputs.
 * This assumes your HTML contains:
 *  - #api-templates (grid for template tiles)
 *  - #api-lines     (container where input boxes will be rendered)
 *  - #meme-preview  (IMG tag for live preview)
 *  - #meme-open     (A tag - open final image in new tab)
 *  - #meme-copy     (Button - copy final URL)
 *  - #meme-download (Button - download the image)
 *  - #meme-search   (Input - search templates)
 *  - #meme-prev-page, #meme-next-page (Buttons)
 *  - #meme-page-label (Span/Div)
 */
export async function initMemeTemplatesDynamic() {
  const tray = $<HTMLDivElement>("api-templates");
  const linesWrap = $<HTMLDivElement>("api-lines");
  const preview = $<HTMLImageElement>("meme-preview");
  const openBtn = $<HTMLAnchorElement>("meme-open");
  const copyBtn = $<HTMLButtonElement>("meme-copy");
  const dlBtn = $<HTMLButtonElement>("meme-download");
  const search = $<HTMLInputElement>("meme-search");
  const prevBtn = $<HTMLButtonElement>("meme-prev-page");
  const nextBtn = $<HTMLButtonElement>("meme-next-page");
  const pageLabel = $<HTMLSpanElement>("meme-page-label");

  // If the API section isn't present on this page, silently exit.
  if (!tray || !linesWrap || !preview || !openBtn) return;

  let all: Template[] = [];
  try {
    all = await memegen.list();
  } catch (err) {
    console.error(err);
    tray.innerHTML = `<div class="text-sm opacity-70 px-3 py-2">Failed to load templates. Please try again.</div>`;
    return;
  }

  let filtered = all.slice();
  let page = 1;

  // Selected template state
  let selectedId: string = filtered[0]?.key || "fry";
  let selectedLineCount: number = filtered[0]?.lines || 2;

  const getLines = (): string[] =>
    Array.from(linesWrap.querySelectorAll<HTMLInputElement>("input.api-line")).map((i) => i.value);

  const buildLineInputs = (count: number) => {
    selectedLineCount = Math.max(1, count | 0);
    linesWrap.innerHTML = "";
    for (let i = 0; i < selectedLineCount; i++) {
      const input = document.createElement("input");
      input.type = "text";
      input.className =
        "api-line w-full bg-transparent border border-white/10 rounded-lg px-3 py-2 text-sm focus-glow";
      input.placeholder = `Text ${i + 1}`;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.addEventListener("input", updatePreview);
      linesWrap.appendChild(input);
    }
  };

  const updateButtons = (finalUrl: string) => {
    openBtn.href = finalUrl;

    copyBtn?.classList.remove("opacity-50", "pointer-events-none");
    dlBtn?.classList.remove("opacity-50", "pointer-events-none");

    on(copyBtn, "click", async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(finalUrl);
        // Optional: toast
        (window as any)?.toast?.success?.("Copied image URL");
      } catch {
        (window as any)?.toast?.error?.("Failed to copy");
      }
    });

    on(dlBtn, "click", async (e) => {
      e.preventDefault();
      try {
        const resp = await fetch(finalUrl, { mode: "cors" });
        const blob = await resp.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${selectedId}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 0);
      } catch {
        (window as any)?.toast?.error?.("Download failed");
      }
    });
  };

  const updatePreview = () => {
    const lines = getLines();
    const prev = memegen.previewUrl(selectedId, lines);
    const fin = memegen.finalUrl(selectedId, lines);
    preview.src = prev;
    updateButtons(fin);
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

    // Bind selection
    tray.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        const btn = b as HTMLButtonElement;
        selectedId = btn.dataset.id || "fry";
        const n = parseInt(btn.dataset.lines || "2", 10);
        buildLineInputs(Number.isFinite(n) ? n : 2);
        // Optional: seed placeholders for quick typing
        linesWrap.querySelectorAll<HTMLInputElement>("input.api-line").forEach((i, idx) => {
          i.placeholder = i.placeholder || `Text ${idx + 1}`;
          i.value = ""; // clear previous
        });
        updatePreview();
        // visual focus
        linesWrap.querySelector<HTMLInputElement>("input.api-line")?.focus();
      })
    );

    // Paging UI
    if (pageLabel) pageLabel.textContent = `${page} / ${totalPages}`;
    if (prevBtn) prevBtn.disabled = page <= 1;
    if (nextBtn) nextBtn.disabled = page >= totalPages;
  };

  // Search
  on(search, "input", () => {
    const q = (search!.value || "").toLowerCase().trim();
    filtered = q
      ? all.filter((t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
      : all.slice();
    page = 1;
    renderPage();
  });

  // Paging
  on(prevBtn, "click", () => {
    page--;
    renderPage();
  });
  on(nextBtn, "click", () => {
    page++;
    renderPage();
  });

  // Initial render + default inputs
  renderPage();
  buildLineInputs(selectedLineCount || 2);
  updatePreview();
}

/** Back-compat boot shims so main.ts can import { initMemeGen } */
export function initMemeGen() {
  return initMemeTemplatesDynamic();
}

// Keep the old name available too
export { initMemeGen as initMeme };

// Optional default export
export default initMemeGen;
