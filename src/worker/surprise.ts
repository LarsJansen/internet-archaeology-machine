import { normalizeDomain } from "./domain-validation";
import { SCREENSHOT_VARIANT, screenshotKey } from "./screenshot-store";

// Bounded R2 inventory discovery. We don't maintain a separate database and
// we never generate a screenshot to populate the Surprise Me experience.
const IMAGE_PREFIX = `screenshots/${SCREENSHOT_VARIANT}/`;
export const SURPRISE_PAGE_SIZE = 200;
export const SURPRISE_MAX_PAGES = 3;

// An intentionally small handpicked domain shortlist, not an assertion that
// each website has an archived capture or that every screenshot was reviewed.
// A site appears only when its image is already in R2. Add entries cautiously.
export const FEATURED_DOMAINS = new Set([
  "yahoo.com", "google.com", "mozilla.org", "apple.com", "microsoft.com",
  "netscape.com", "aol.com", "altavista.com", "amazon.com", "ebay.com",
  "msn.com", "hotmail.com", "ask.com", "reddit.com", "twitter.com",
  "youtube.com", "facebook.com", "myspace.com", "wikipedia.org",
  "archive.org", "cnn.com", "bbc.co.uk", "slashdot.org", "digg.com",
  "php.net", "wordpress.org", "geocities.com", "newgrounds.com",
]);

export function isFeaturedDomain(domain: string): boolean {
  return FEATURED_DOMAINS.has(domain) ||
    (domain.startsWith("www.") && FEATURED_DOMAINS.has(domain.slice(4)));
}

export interface SavedDiscovery {
  year: number;
  timestamp: string;
  replayUrl: string;
  screenshotUrl: string;
}

export interface SurpriseDiscovery {
  domain: string;
  captures: SavedDiscovery[];
  inventoryPartial: boolean;
  source: "r2-cached-screenshots";
  limitation: string;
}

export type StoredCapture = { domain: string; year: number; timestamp: string; replayUrl: string };

export function storedCapture(object: R2Object): StoredCapture | null {
  const match = /^screenshots\/[^/]+\/([^/]+)\/(\d{14})\.png$/.exec(object.key);
  if (!match || !object.key.startsWith(IMAGE_PREFIX)) return null;

  const meta = object.customMetadata;
  if (!meta) return null;
  const { domain, captureTimestamp, requestedYear, replayUrl, originalUrl } = meta;
  if (!domain || !captureTimestamp || !requestedYear || !replayUrl || !originalUrl) return null;

  const checked = normalizeDomain(domain);
  if (!checked.ok || checked.domain !== domain || encodeURIComponent(domain) !== match[1]) return null;
  if (captureTimestamp !== match[2]) return null;
  const year = Number(captureTimestamp.slice(0, 4));
  if (
    !Number.isInteger(year) ||
    year < 1996 ||
    year > new Date().getUTCFullYear() ||
    requestedYear !== String(year)
  ) return null;

  try {
    const original = new URL(originalUrl);
    const replay = new URL(replayUrl);
    if (
      !["http:", "https:"].includes(original.protocol) ||
      replay.protocol !== "https:" ||
      replay.hostname !== "web.archive.org" ||
      !replay.pathname.startsWith(`/web/${captureTimestamp}/`) ||
      (!original.hostname.endsWith(`.${domain}`) && original.hostname !== domain)
    ) return null;
  } catch {
    return null;
  }

  return { domain, year, timestamp: captureTimestamp, replayUrl };
}

function randomIndex(size: number, rng: () => number): number {
  return Math.max(0, Math.min(size - 1, Math.floor(rng() * size)));
}

function toPublicCapture(capture: StoredCapture): SavedDiscovery {
  return {
    year: capture.year,
    timestamp: capture.timestamp,
    replayUrl: capture.replayUrl,
    screenshotUrl: `/api/screenshot?domain=${encodeURIComponent(capture.domain)}&year=${capture.year}&timestamp=${capture.timestamp}`,
  };
}

// Returns one randomly chosen cached domain (prefer one with two years) and
// up to two independently cached screenshots. No CDX, Browser Run or writes.
export async function findSurprise(
  storage: Pick<R2Bucket, "list">,
  excludeDomain = "",
  rng: () => number = Math.random,
  isAllowed: (domain: string) => boolean = isFeaturedDomain,
): Promise<SurpriseDiscovery | null> {
  const grouped = new Map<string, Map<number, StoredCapture>>();
  let cursor: string | undefined;
  let partial = false;

  for (let page = 0; page < SURPRISE_MAX_PAGES; page++) {
    const list = await storage.list({
      prefix: IMAGE_PREFIX,
      limit: SURPRISE_PAGE_SIZE,
      include: ["customMetadata"],
      ...(cursor ? { cursor } : {}),
    });
    for (const object of list.objects) {
      const capture = storedCapture(object);
      if (!capture || !isAllowed(capture.domain)) continue;
      let years = grouped.get(capture.domain);
      if (!years) {
        years = new Map<number, StoredCapture>();
        grouped.set(capture.domain, years);
      }
      if (!years.has(capture.year)) years.set(capture.year, capture);
    }
    partial = list.truncated;
    if (!list.truncated || !list.cursor) break;
    cursor = list.cursor;
  }

  const options = [...grouped.entries()];
  if (!options.length) return null;
  const pairs = options.filter(([, years]) => years.size >= 2);
  let eligible = pairs.length ? pairs : options;

  // Avoid the immediate previous domain when there is another eligible one.
  if (eligible.length > 1 && excludeDomain) {
    const alternatives = eligible.filter(([domain]) => domain !== excludeDomain);
    if (alternatives.length) eligible = alternatives;
  }
  const [domain, years] = eligible[randomIndex(eligible.length, rng)];
  const captures = [...years.values()].sort((a, b) => a.year - b.year);
  const selected = captures.length <= 2 ? captures : [
    captures[randomIndex(captures.length, rng)],
  ];
  if (captures.length > 2) {
    const remaining = captures.filter((capture) => capture.year !== selected[0].year);
    selected.push(remaining[randomIndex(remaining.length, rng)]);
  }
  selected.sort((a, b) => a.year - b.year);

  return {
    domain,
    captures: selected.map(toPublicCapture),
    inventoryPartial: partial,
    source: "r2-cached-screenshots",
    limitation: "This discovery uses a handpicked website list and saved Wayback screenshots; individual images are not manually reviewed. Replays may redirect or load later resources, so capture timestamps are not independently verified render dates.",
  };
}
