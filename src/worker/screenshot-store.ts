import type { Capture } from "../shared/capture-types";

// Bump this when the viewport, renderer settings, or toolbar-hiding policy changes.
// Existing R2 objects remain immutable evidence of the earlier rendering recipe.
export const SCREENSHOT_VARIANT = "toolbarless-v1-1280x900";

export function screenshotKey(domain: string, captureTimestamp: string): string {
  return `screenshots/${SCREENSHOT_VARIANT}/${encodeURIComponent(domain)}/${captureTimestamp}.png`;
}

export function screenshotMetadata(domain: string, year: number, capture: Capture): Record<string, string> {
  return {
    domain,
    requestedYear: String(year),
    captureTimestamp: capture.timestamp,
    originalUrl: capture.originalUrl,
    replayUrl: capture.replayUrl,
    generatedAt: new Date().toISOString(),
    rendererVersion: SCREENSHOT_VARIANT,
    // Wayback can redirect or load newer assets. This is not a verified render-date claim.
    renderDateVerified: "false",
  };
}

export function screenshotImage(body: BodyInit | null, origin: "cached" | "generated"): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
      "X-IAM-Screenshot-Source": origin,
    },
  });
}
