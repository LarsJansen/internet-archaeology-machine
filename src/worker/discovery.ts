import { normalizeDomain } from "./domain-validation";
import { screenshotKey } from "./screenshot-store";
import { storedCapture } from "./surprise";
import type { DiscoveryRoute, SavedDiscoveryResponse } from "../shared/discovery-link";
import { isValidDiscoveryRoute, buildDiscoveryPath } from "../shared/discovery-link";

const DISCLAIMER = "These screenshots are modern renderings of Internet Archive replays. Wayback may redirect or load newer assets; dates identify indexed captures, not necessarily the rendered page.";

export async function getSavedDiscovery(
  storage: Pick<R2Bucket, "head">,
  route: DiscoveryRoute,
): Promise<SavedDiscoveryResponse | null> {
  const validated = normalizeDomain(route.domain);
  if (!validated.ok || validated.domain !== route.domain ||
      !isValidDiscoveryRoute(route.domain, route.timestamps)) return null;

  const objects = await Promise.all(route.timestamps.map((timestamp) =>
    storage.head(screenshotKey(route.domain, timestamp))
  ));
  if (objects.some((object) => !object)) return null;

  const captures = objects.map((object, index) => {
    if (!object) return null;
    const checked = storedCapture(object);
    if (!checked || checked.domain !== route.domain ||
        checked.timestamp !== route.timestamps[index]) return null;
    return {
      year: checked.year,
      timestamp: checked.timestamp,
      replayUrl: checked.replayUrl,
      screenshotUrl: `/api/screenshot?domain=${encodeURIComponent(route.domain)}&year=${checked.year}&timestamp=${checked.timestamp}`,
    };
  });
  if (captures.some((capture) => !capture)) return null;
  return {
    domain: route.domain,
    captures: captures as SavedDiscoveryResponse["captures"],
    source: "r2-cached-screenshots",
    limitation: DISCLAIMER,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] ?? char);
}

export function discoveryMeta(page: SavedDiscoveryResponse, origin: string): { title: string; tags: string } {
  const years = page.captures.map((capture) => String(capture.year));
  const title = `${page.domain} in ${years.join(" vs ")} | Internet Archaeology Machine`;
  const description = page.captures.length === 2
    ? `See how ${page.domain} changed between its archived ${years[0]} and ${years[1]} snapshots. Real saved Wayback images and source links.`
    : `See a saved Wayback snapshot of ${page.domain} from ${years[0]}, with the original archive source.`;
  const route = buildDiscoveryPath(page.domain, page.captures.map((capture) => capture.timestamp));
  const pageUrl = new URL(route, origin).href;
  // This is one actual cached replay image, not a fabricated composite. The
  // linked page shows both images for a comparison.
  const image = new URL(page.captures[0].screenshotUrl, origin).href;
  const escapedTitle = escapeHtml(title);
  const escapedDescription = escapeHtml(description);
  const meta = [
    `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Internet Archaeology Machine" />`,
    `<meta property="og:title" content="${escapedTitle}" />`,
    `<meta property="og:description" content="${escapedDescription}" />`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:width" content="1280" />`,
    `<meta property="og:image:height" content="900" />`,
    `<meta property="og:image:alt" content="${escapeHtml(`Saved Wayback screenshot for ${page.domain} in ${years[0]}`)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapedTitle}" />`,
    `<meta name="twitter:description" content="${escapedDescription}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
  ];
  return { title, tags: meta.join("\n    ") };
}

export async function renderDiscoveryHtml(
  request: Request,
  assets: Pick<Fetcher, "fetch">,
  page: SavedDiscoveryResponse,
): Promise<Response> {
  const source = await assets.fetch(new Request(new URL("/", request.url), {
    headers: { Accept: "text/html" },
  }));
  if (!source.ok) return new Response("The discovery page is temporarily unavailable.", {
    status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
  const html = await source.text();
  const { title, tags } = discoveryMeta(page, new URL(request.url).origin);
  if (!html.includes("</head>")) return new Response("The discovery page is temporarily unavailable.", {
    status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
  let dynamic = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
  dynamic = dynamic.replace(/<meta name="description" content="[^"]*"\s*\/>/,
    `<meta name="description" content="${escapeHtml(title + " — saved Wayback screenshots.")}" />`);
  dynamic = dynamic.replace("</head>", `    ${tags}\n  </head>`);
  return new Response(dynamic, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=60, s-maxage=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
