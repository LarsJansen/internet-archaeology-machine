// An immutable discovery URL identifies one domain and one or two exact CDX
// capture timestamps. It never encodes a screenshot destination or owner token.
export interface DiscoveryRoute {
  domain: string;
  timestamps: string[];
}

const DOMAIN = /^(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)+$/;
const TIMESTAMP = /^\d{14}$/;

export function isValidDiscoveryRoute(domain: string, timestamps: readonly string[]): boolean {
  return domain.length <= 253 && DOMAIN.test(domain) &&
    timestamps.length >= 1 && timestamps.length <= 2 &&
    timestamps.every((stamp) => TIMESTAMP.test(stamp) &&
      Number(stamp.slice(0, 4)) >= 1996 &&
      Number(stamp.slice(0, 4)) <= new Date().getUTCFullYear()) &&
    new Set(timestamps).size === timestamps.length;
}

export function buildDiscoveryPath(domain: string, timestamps: readonly string[]): string {
  const cleanDomain = domain.trim().toLowerCase();
  const ordered = [...timestamps].sort();
  if (!isValidDiscoveryRoute(cleanDomain, ordered)) throw new Error("A valid saved capture is required to share this discovery.");
  return `/discover/${encodeURIComponent(cleanDomain)}/${ordered.join("/")}`;
}

export function parseDiscoveryPath(pathname: string): DiscoveryRoute | null {
  if (!pathname.startsWith("/discover/")) return null;
  const parts = pathname.split("/");
  if (parts.length !== 4 && parts.length !== 5) return null;
  try {
    const domain = decodeURIComponent(parts[2]);
    const timestamps = parts.slice(3);
    if (!isValidDiscoveryRoute(domain, timestamps)) return null;
    if ([...timestamps].sort().join(",") !== timestamps.join(",")) return null;
    return { domain, timestamps };
  } catch {
    return null;
  }
}

export interface SavedDiscoveryCapture {
  year: number;
  timestamp: string;
  replayUrl: string;
  screenshotUrl: string;
}

export interface SavedDiscoveryResponse {
  domain: string;
  captures: SavedDiscoveryCapture[];
  source: "r2-cached-screenshots";
  limitation: string;
}

export function isSavedDiscoveryResponse(value: unknown, expected: DiscoveryRoute): value is SavedDiscoveryResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SavedDiscoveryResponse>;
  if (
    result.source !== "r2-cached-screenshots" ||
    result.domain !== expected.domain ||
    typeof result.limitation !== "string" ||
    !Array.isArray(result.captures) ||
    result.captures.length !== expected.timestamps.length
  ) return false;
  return result.captures.every((capture, index) => {
    const stamp = expected.timestamps[index];
    if (!capture || capture.timestamp !== stamp || capture.year !== Number(stamp.slice(0, 4)) ||
      typeof capture.replayUrl !== "string" || typeof capture.screenshotUrl !== "string") return false;
    try {
      const archive = new URL(capture.replayUrl);
      const screenshot = new URL(capture.screenshotUrl, "https://iam.test");
      return archive.origin === "https://web.archive.org" &&
        archive.pathname.startsWith(`/web/${stamp}/`) &&
        screenshot.origin === "https://iam.test" &&
        screenshot.pathname === "/api/screenshot" &&
        screenshot.searchParams.get("domain") === expected.domain &&
        screenshot.searchParams.get("year") === String(capture.year) &&
        screenshot.searchParams.get("timestamp") === stamp;
    } catch {
      return false;
    }
  });
}
