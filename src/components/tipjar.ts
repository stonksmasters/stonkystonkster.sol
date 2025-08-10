// src/components/tipjar.ts
//
// Binds the Tip Jar UI:
// - Connect/Disconnect Phantom
// - Send preset/custom tips (desktop → wallet, mobile → Solana Pay/QR fallback)
// - QR modal (Solana Pay deep link) with lazy-loaded QR lib
// - Recent tips feed (last 10) with polite polling/backoff

import {
  buildSolanaPayUrl,
  ensureRecipient,
  getCluster,
  getProvider,
  getConnection,
  loadRecentTips,
  sendTip,
} from "./solana";
import { CONFIG } from "./config";
import type { PublicKey } from "@solana/web3.js";

// -------------------- tiny utils --------------------
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => {
  const el = document.querySelector(sel) as T | null;
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

let refreshTimer: number | null = null;
let refreshing = false;
let backoffMs = 0;

function scheduleRefresh(ms: number) {
  if (refreshTimer) window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshFeed, ms);
}

function formatWhen(ts?: number) {
  return ts ? new Date(ts * 1000).toLocaleString() : "";
}

// -------------------- feed --------------------
async function refreshFeed() {
  if (refreshing) return;
  refreshing = true;
  try {
    const items = await loadRecentTips();
    const feed = $("#tip-feed") as HTMLUListElement;

    if (!items.length) {
      feed.innerHTML = `<li class="text-white/60 text-sm">No recent tips yet.</li>`;
    } else {
      const cluster = getCluster();
      const clusterSuffix = cluster === "mainnet" ? "" : `?cluster=${cluster}`;
      feed.innerHTML = items
        .map((i) => {
          const link = `https://explorer.solana.com/tx/${i.sig}${clusterSuffix}`;
          return `<li class="glass rounded px-3 py-2 border border-white/10 flex items-center justify-between">
              <div>
                <a class="underline" href="${link}" target="_blank" rel="noopener">${i.sig.slice(0, 4)}…${i.sig.slice(-4)}</a>
                <span class="ml-2 text-white/70">${i.sol} SOL</span>
              </div>
              <div class="text-xs text-white/50">${formatWhen(i.when)}</div>
            </li>`;
        })
        .join("");
    }

    backoffMs = 0;
    scheduleRefresh(60_000); // every 60s
  } catch (e: any) {
    const is429 =
      String(e?.message || e).includes("429") ||
      /too many requests/i.test(String(e?.message || e));
    backoffMs = backoffMs ? Math.min(backoffMs * 2, 120_000) : 20_000;
    scheduleRefresh(is429 ? Math.max(60_000, backoffMs) : Math.max(45_000, backoffMs));
  } finally {
    refreshing = false;
  }
}

async function updateOwnerLabel() {
  const el = $("#owner-sol");
  try {
    const to = await ensureRecipient();
    el.textContent = `${to.slice(0, 4)}…${to.slice(-4)}`;
  } catch {
    el.textContent = "—";
  }
}

function setConnectButton(pk?: string) {
  const btn = $("#connect-wallet") as HTMLButtonElement;
  if (pk) {
    btn.textContent = `${pk.slice(0, 4)}…${pk.slice(-4)}`;
    btn.classList.add("opacity-90");
  } else {
    btn.textContent = "Connect Wallet";
    btn.classList.remove("opacity-90");
  }
}

// -------------------- QR modal --------------------
let lastSolUrl: string | null = null;

function buildPhantomUniversal(solUrl: string) {
  return `https://phantom.app/ul/v1/pay?link=${encodeURIComponent(solUrl)}`;
}

// Lazy-load a tiny QR lib (QRCode.js). Resolve false if it fails.
function ensureQrLib(): Promise<boolean> {
  // @ts-ignore
  if (window.QRCode) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

function ensureQrBox(canvas: HTMLCanvasElement) {
  let box = document.getElementById("qr-box") as HTMLDivElement | null;
  if (!box) {
    box = document.createElement("div");
    box.id = "qr-box";
    box.className = canvas.className; // keep styles
    canvas.insertAdjacentElement("afterend", box);
  }
  return box;
}

function drawQrFallbackToCanvas(canvas: HTMLCanvasElement, text: string) {
  canvas.classList.remove("hidden");
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.font = "14px monospace";
  const lines = text.match(/.{1,40}/g) || [text];
  lines.forEach((line, i) => ctx.fillText(line, 10, 28 + i * 18));
}

async function renderQr(solUrl: string) {
  const canvas = $("#qr-canvas") as HTMLCanvasElement;

  const ok = await ensureQrLib();
  // @ts-ignore
  if (ok && window.QRCode) {
    const box = ensureQrBox(canvas);
    canvas.classList.add("hidden");
    box.innerHTML = "";
    try {
      // @ts-ignore
      new window.QRCode(box, {
        text: solUrl,
        width: 256,
        height: 256,
        correctLevel: 0,
      });
      return;
    } catch {
      /* fall through to canvas */
    }
  }

  // Fallback: text on canvas
  drawQrFallbackToCanvas(canvas, solUrl);
}

async function openQr(solUrl: string, amount: number, recipient: string) {
  lastSolUrl = solUrl;

  const backdrop = $("#qr-backdrop");
  const openBtn = $("#qr-open") as HTMLAnchorElement;
  const amt = $("#qr-amount");
  const rec = $("#qr-recipient");

  amt.textContent = String(amount);
  rec.textContent = recipient;

  if (IS_MOBILE) {
    openBtn.href = buildPhantomUniversal(solUrl);
    openBtn.textContent = "Open in Phantom";
    openBtn.classList.remove("hidden");
  } else {
    openBtn.removeAttribute("href");
    openBtn.classList.add("hidden");
  }

  await renderQr(solUrl);
  backdrop.classList.remove("hidden");
}

function wireQrModal() {
  $("#qr-close").addEventListener("click", () => {
    $("#qr-backdrop").classList.add("hidden");
  });

  $("#qr-copy").addEventListener("click", async () => {
    try {
      if (!lastSolUrl) return;
      await navigator.clipboard.writeText(lastSolUrl);
    } catch {
      /* ignore */
    }
  });
}

// -------------------- send flow --------------------
async function handleSend(amount: number) {
  if (!amount || amount <= 0) return;

  const provider = getProvider();

  // No wallet installed
  if (!provider) {
    if (IS_MOBILE) {
      const to = await ensureRecipient();
      const solUrl = buildSolanaPayUrl(
        to,
        amount,
        `${CONFIG.OWNER_SOL_DOMAIN || "Tip Jar"}`,
        `Thanks for the tip (${getCluster()})`
      );
      await openQr(solUrl, amount, to);
    } else {
      window.open("https://phantom.app/", "_blank", "noopener");
    }
    return;
  }

  // Wallet installed → try to connect & send
  try {
    if (!provider.publicKey) {
      await provider.connect({ onlyIfTrusted: false });
    }
    const from = provider.publicKey as PublicKey | undefined;
    if (!from) throw new Error("connect_failed");

    await sendTip(from, amount);
    scheduleRefresh(4_000);
  } catch (e: any) {
    const code = e?.code;
    const msg = String(e?.message || e || "");
    if (code === 4001 || /reject/i.test(msg)) return; // user canceled

    if (!IS_MOBILE) {
      console.warn("Send failed on desktop:", e);
      return;
    }

    // Mobile fallback: Solana Pay + QR
    try {
      const to = await ensureRecipient();
      const solUrl = buildSolanaPayUrl(
        to,
        amount,
        `${CONFIG.OWNER_SOL_DOMAIN || "Tip Jar"}`,
        `Thanks for the tip (${getCluster()})`
      );
      await openQr(solUrl, amount, to);
    } catch {
      /* ignore */
    }
  }
}

// -------------------- init --------------------
function ensureSendButton() {
  const qrBtn = $("#qr-tip") as HTMLButtonElement;
  let sendBtn = document.getElementById("send-tip") as HTMLButtonElement | null;
  if (!sendBtn) {
    sendBtn = document.createElement("button");
    sendBtn.id = "send-tip";
    sendBtn.type = "button";
    // match the gradient primary style you used elsewhere
    sendBtn.className =
      "btn-grad px-3 py-2 rounded-lg font-semibold text-sm hover:scale-105 transition";
    sendBtn.textContent = "Send";
    // place it just before the QR button
    qrBtn.insertAdjacentElement("beforebegin", sendBtn);
  }
  sendBtn.onclick = async () => {
    const input = $("#custom-tip") as HTMLInputElement;
    const amount = Number(input.value);
    await handleSend(amount);
  };
}

export function initTipJar() {
  // Ensure connection created
  getConnection();

  // Wire QR modal controls
  wireQrModal();

  // Show recipient & cluster
  updateOwnerLabel();

  // Add runtime "Send" button for custom amounts
  ensureSendButton();

  // Hitting Enter in the custom amount field sends via wallet (desktop), with mobile fallback
  const customInput = $("#custom-tip") as HTMLInputElement;
  customInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const amount = Number(customInput.value);
      await handleSend(amount);
    }
  });

  // Connect wallet button
  const connectBtn = $("#connect-wallet") as HTMLButtonElement;
  connectBtn.onclick = async () => {
    const provider = getProvider();
    if (!provider) {
      if (IS_MOBILE) {
        const to = await ensureRecipient();
        const amount = Number(($("#custom-tip") as HTMLInputElement).value) || 0.05;
        const solUrl = buildSolanaPayUrl(
          to,
          amount,
          `${CONFIG.OWNER_SOL_DOMAIN || "Tip Jar"}`,
          `Thanks for the tip (${getCluster()})`
        );
        await openQr(solUrl, amount, to);
      } else {
        window.open("https://phantom.app/", "_blank", "noopener");
      }
      return;
    }
    try {
      const res = await provider.connect({ onlyIfTrusted: false });
      const pk =
        res?.publicKey?.toBase58?.() ?? provider.publicKey?.toBase58?.();
      setConnectButton(pk);
      scheduleRefresh(2_000);
    } catch {
      setConnectButton(undefined);
    }
  };

  // Wallet events
  try {
    const provider = getProvider();
    provider?.on?.("connect", () => {
      const pk = provider.publicKey?.toBase58?.();
      setConnectButton(pk);
      scheduleRefresh(2_000);
    });
    provider?.on?.("disconnect", () => {
      setConnectButton(undefined);
    });
    provider?.on?.("accountChanged", (pk: PublicKey | null) => {
      setConnectButton(pk ? (pk as any).toBase58() : undefined);
    });
  } catch {
    /* noop */
  }

  // Tip preset buttons (always send via wallet if available; mobile fallback handled in handleSend)
  document.querySelectorAll<HTMLButtonElement>(".tip-btn").forEach((btn) => {
    btn.onclick = async () => {
      const amt = Number(btn.dataset.amount || "0");
      await handleSend(amt);
    };
  });

  // QR button (always available)
  $("#qr-tip").addEventListener("click", async () => {
    const input = $("#custom-tip") as HTMLInputElement;
    const amount = Number(input.value) || 0.05;
    const to = await ensureRecipient();
    const solUrl = buildSolanaPayUrl(
      to,
      amount,
      `${CONFIG.OWNER_SOL_DOMAIN || "Tip Jar"}`,
      `Thanks for the tip (${getCluster()})`
    );
    await openQr(solUrl, amount, to);
  });

  // Initial gentle load
  scheduleRefresh(3_000);
}
