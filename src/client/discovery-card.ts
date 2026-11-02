import type { Capture } from "../shared/capture-types";

export interface DiscoveryCardEntry {
  year: number;
  capture: Capture;
  image: HTMLImageElement;
}

export const CARD_WIDTH = 1600;
export const CARD_HEIGHT = 1100;

const COLORS = {
  paper: "#f3f6fb",
  white: "#ffffff",
  ink: "#14243a",
  blue: "#245cc5",
  muted: "#64748b",
  border: "#dce6f2",
  pale: "#e8f0fd",
};

function captureDate(timestamp: string): string {
  if (!/^\d{14}$/.test(timestamp)) return "Archive date unavailable";
  return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)} UTC`;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let shortened = text;
  while (shortened && ctx.measureText(shortened + "…").width > maxWidth) shortened = shortened.slice(0, -1);
  return shortened + "…";
}

function drawPanel(ctx: CanvasRenderingContext2D, entry: DiscoveryCardEntry, x: number, index: number): void {
  const width = 740;
  const top = 235;
  const imageTop = 355;
  const imageHeight = 535;

  ctx.fillStyle = COLORS.white;
  ctx.fillRect(x, top, width, 748);
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, top, width, 748);

  ctx.font = "bold 48px system-ui, sans-serif";
  ctx.fillStyle = COLORS.blue;
  ctx.fillText(String(entry.year), x + 25, top + 64);

  ctx.font = "17px system-ui, sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(index === 0 ? "FIRST DISCOVERY" : "SECOND DISCOVERY", x + width - 203, top + 51);

  ctx.font = "20px system-ui, sans-serif";
  ctx.fillStyle = COLORS.ink;
  ctx.fillText(`Capture: ${captureDate(entry.capture.timestamp)}`, x + 25, top + 100);

  ctx.fillStyle = COLORS.pale;
  ctx.fillRect(x + 24, imageTop, width - 48, imageHeight);
  const imageWidth = entry.image.naturalWidth;
  const sourceHeight = entry.image.naturalHeight;
  if (imageWidth > 0 && sourceHeight > 0) {
    const scale = Math.min((width - 48) / imageWidth, imageHeight / sourceHeight);
    const scaledWidth = imageWidth * scale;
    const scaledHeight = sourceHeight * scale;
    ctx.drawImage(
      entry.image,
      x + 24 + ((width - 48) - scaledWidth) / 2,
      imageTop + (imageHeight - scaledHeight) / 2,
      scaledWidth,
      scaledHeight,
    );
  }

  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText("SOURCE · INTERNET ARCHIVE / WAYBACK MACHINE", x + 25, 923);
  ctx.font = "17px ui-monospace, Consolas, monospace";
  ctx.fillStyle = COLORS.ink;
  ctx.fillText(fitText(ctx, `web.archive.org/web/${entry.capture.timestamp}/…`, width - 50), x + 25, 956);
}

export function renderDiscoveryCard(canvas: HTMLCanvasElement, domain: string, entries: readonly DiscoveryCardEntry[]): void {
  if (entries.length !== 2) throw new Error("Choose two archived screenshots to export.");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser does not support drawing an image card.");
  for (const entry of entries) {
    if (!entry.image.complete || entry.image.naturalWidth <= 0 || entry.image.naturalHeight <= 0) {
      throw new Error("Both archived screenshots must finish loading before export.");
    }
  }
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;

  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.fillStyle = COLORS.blue;
  ctx.fillRect(0, 0, CARD_WIDTH, 12);
  ctx.font = "bold 24px system-ui, sans-serif";
  ctx.fillStyle = COLORS.blue;
  ctx.fillText("INTERNET ARCHAEOLOGY MACHINE", 38, 67);
  ctx.font = "bold 65px system-ui, sans-serif";
  ctx.fillStyle = COLORS.ink;
  ctx.fillText(fitText(ctx, domain, 1470), 38, 144);
  ctx.font = "24px system-ui, sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText("Two moments from the internet's past", 40, 189);

  entries.forEach((entry, index) => drawPanel(ctx, entry, index === 0 ? 38 : 822, index));

  ctx.fillStyle = COLORS.ink;
  ctx.font = "bold 19px system-ui, sans-serif";
  ctx.fillText("Made with Internet Archaeology Machine", 39, 1028);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText("Screenshots are modern renderings of archived replays. Redirects or later assets may affect what you see.", 40, 1062);
}

export function discoverySources(domain: string, entries: readonly DiscoveryCardEntry[]): string {
  return [
    `Internet Archaeology Machine — ${domain}`,
    ...entries.map((entry) =>
      `Requested year ${entry.year} | CDX capture ${captureDate(entry.capture.timestamp)} | ${entry.capture.replayUrl}`
    ),
    "Note: Screenshots are modern renderings of archived replays; redirects and later resources may affect their contents.",
  ].join("\n");
}
