import QRCode from "qrcode";

export const isMobile = () =>
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

export function makeSolanaPayURL(
  recipient: string,
  amountSol: number,
  opts?: { label?: string; message?: string; reference?: string; splToken?: string }
): string {
  const u = new URL(`solana:${recipient}`);
  if (amountSol && amountSol > 0) u.searchParams.set("amount", String(amountSol));
  if (opts?.label)   u.searchParams.set("label", opts.label);
  if (opts?.message) u.searchParams.set("message", opts.message);
  if (opts?.reference) u.searchParams.set("reference", opts.reference);
  if (opts?.splToken)  u.searchParams.set("spl-token", opts.splToken);
  return u.toString();
}

export async function drawQR(canvas: HTMLCanvasElement, url: string) {
  await QRCode.toCanvas(canvas, url, { errorCorrectionLevel: "M", margin: 1, width: 280 });
}
