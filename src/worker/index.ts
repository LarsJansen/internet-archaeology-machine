import type { ApiErrorResponse, CapturesResponse, YearsResponse } from "../shared/capture-types";
import { ArchiveProviderError, fetchCaptures, fetchYearCaptures, fetchIndexedYears } from "./archive-provider";
import { normalizeDomain } from "./domain-validation";
import { screenshotImage, screenshotKey, screenshotMetadata } from "./screenshot-store";

const ARCHIVE_LIMITATION =
  "Results are a small sample of surviving indexed homepage captures. Gaps do not prove the site was offline.";
const FIRST_ARCHIVE_YEAR = 1996;

export interface Env {
  BROWSER: BrowserRun;
  SCREENSHOT_ACCESS_TOKEN?: string;
  SCREENSHOTS?: R2Bucket;
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function errorResponse(code: string, message: string, status: number, headers?: HeadersInit): Response {
  const body: ApiErrorResponse = { error: { code, message } };
  return json(body, { status, headers: { "Cache-Control": "no-store", ...Object.fromEntries(new Headers(headers)) } });
}

async function tokensMatch(provided: string | null, expected: string): Promise<boolean> {
  if (!provided) return false;
  const encoder = new TextEncoder();
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const providedBytes = new Uint8Array(providedDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < providedBytes.length; index += 1) {
    difference |= providedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}

export async function handleRequest(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  env: Partial<Env> = {},
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/screenshot") {
    if (request.method !== "GET" && request.method !== "POST") {
      return errorResponse("METHOD_NOT_ALLOWED", "Only GET and POST are supported.", 405, { Allow: "GET, POST" });
    }

    // Public, read-only access. No token, Browser Run, or archive request is needed
    // to retrieve an existing immutable screenshot by validated CDX timestamp.
    if (request.method === "GET") {
      const domain = normalizeDomain(url.searchParams.get("domain") ?? "");
      if (!domain.ok) return errorResponse(domain.code, domain.message, 400);
      const yearText = url.searchParams.get("year") ?? "";
      const timestamp = url.searchParams.get("timestamp") ?? "";
      const year = Number(yearText);
      if (
        !/^\d{4}$/.test(yearText) ||
        year < FIRST_ARCHIVE_YEAR ||
        year > new Date().getUTCFullYear() ||
        !/^\d{14}$/.test(timestamp) ||
        !timestamp.startsWith(yearText)
      ) {
        return errorResponse("INVALID_SCREENSHOT_LOOKUP", "Provide a valid capture year and its 14-digit timestamp.", 400);
      }
      if (!env.SCREENSHOTS) {
        return errorResponse("SCREENSHOT_CACHE_UNAVAILABLE", "Shared screenshot storage is not configured.", 503);
      }
      try {
        const stored = await env.SCREENSHOTS.get(screenshotKey(domain.domain, timestamp));
        if (!stored) {
          return errorResponse("SCREENSHOT_NOT_CACHED", "No saved screenshot is available for this capture yet.", 404);
        }
        return screenshotImage(stored.body, "cached");
      } catch {
        return errorResponse("SCREENSHOT_STORAGE_ERROR", "Saved screenshots are temporarily unavailable.", 503);
      }
    }

    // Only the owner may cause archive and Browser Run requests or storage writes.
    if (!env.SCREENSHOT_ACCESS_TOKEN) {
      return errorResponse(
        "SCREENSHOT_DISABLED",
        "The active Worker deployment cannot access SCREENSHOT_ACCESS_TOKEN. Check its exact secret name and deploy it to Production.",
        503,
      );
    }
    if (!(await tokensMatch(request.headers.get("X-Screenshot-Token"), env.SCREENSHOT_ACCESS_TOKEN))) {
      return errorResponse("SCREENSHOT_UNAUTHORIZED", "Screenshot access is restricted to the owner.", 401);
    }
    if (!env.SCREENSHOTS) {
      return errorResponse("SCREENSHOT_CACHE_UNAVAILABLE", "Configure the SCREENSHOTS R2 binding before generating images.", 503);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Provide a domain and year as JSON.", 400);
    }
    if (!payload || typeof payload !== "object") {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Provide a domain and year as JSON.", 400);
    }
    const candidate = payload as { domain?: unknown; year?: unknown };
    if (typeof candidate.domain !== "string" || typeof candidate.year !== "number") {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Provide a domain and year as JSON.", 400);
    }
    const validation = normalizeDomain(candidate.domain);
    if (!validation.ok) {
      return errorResponse(validation.code, validation.message, 400);
    }
    const currentYear = new Date().getUTCFullYear();
    if (!Number.isInteger(candidate.year) || candidate.year < FIRST_ARCHIVE_YEAR || candidate.year > currentYear) {
      return errorResponse("INVALID_YEAR", `Choose a year from ${FIRST_ARCHIVE_YEAR} to ${currentYear}.`, 400);
    }

    try {
      const captures = await fetchYearCaptures(validation.domain, candidate.year, fetchImpl);
      if (captures.length === 0) {
        return errorResponse(
          "SCREENSHOT_CAPTURE_NOT_FOUND",
          `No verified homepage capture was returned for ${validation.domain} in ${candidate.year}.`,
          404,
        );
      }
      const capture = captures[0];
      const key = screenshotKey(validation.domain, capture.timestamp);
      let existing: R2ObjectBody | null;
      try {
        existing = await env.SCREENSHOTS.get(key);
      } catch {
        return errorResponse("SCREENSHOT_STORAGE_ERROR", "Could not check screenshot storage safely.", 503);
      }
      if (existing) return screenshotImage(existing.body, "cached");
      if (!env.BROWSER) {
        return errorResponse(
          "SCREENSHOT_BROWSER_UNAVAILABLE",
          "The active Worker deployment cannot access the BROWSER binding. Check the production version bindings.",
          503,
        );
      }

      const browserResponse = await env.BROWSER.quickAction("screenshot", {
        url: capture.replayUrl,
        // Hide only the Wayback UI overlay, not the archived page itself.
        addStyleTag: [{ content: "#wm-ipp-base, #donato { display: none !important; }" }],
        viewport: { width: 1280, height: 900 },
        gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
        bestAttempt: true,
        cacheTTL: 0,
        screenshotOptions: { type: "png", fullPage: false },
      });
      if (browserResponse.status === 429) {
        return errorResponse(
          "SCREENSHOT_RATE_LIMITED",
          "Cloudflare Browser Run is rate limited. Wait before trying again.",
          429,
          { "Retry-After": browserResponse.headers.get("Retry-After") ?? "10" },
        );
      }
      if (!browserResponse.ok || !browserResponse.headers.get("Content-Type")?.startsWith("image/png")) {
        return errorResponse("SCREENSHOT_UNAVAILABLE", "Cloudflare Browser Run could not capture this replay.", 502);
      }
      const png = await browserResponse.arrayBuffer();
      if (png.byteLength === 0 || png.byteLength > 8 * 1024 * 1024) {
        return errorResponse("SCREENSHOT_UNAVAILABLE", "The screenshot image was empty or too large.", 502);
      }
      try {
        await env.SCREENSHOTS.put(key, png, {
          httpMetadata: { contentType: "image/png" },
          customMetadata: screenshotMetadata(validation.domain, candidate.year, capture),
        });
      } catch {
        return errorResponse("SCREENSHOT_STORAGE_ERROR", "The screenshot was rendered but could not be saved.", 503);
      }
      return screenshotImage(png, "generated");
    } catch (error) {
      if (error instanceof ArchiveProviderError) {
        if (error.code === "ARCHIVE_RATE_LIMITED") {
          return errorResponse(error.code, error.message, 503, { "Retry-After": "60" });
        }
        return errorResponse(error.code, error.message, 502);
      }
      return errorResponse("SCREENSHOT_UNAVAILABLE", "Cloudflare Browser Run could not capture this replay.", 502);
    }
  }

  if (url.pathname.startsWith("/api/") && request.method !== "GET") {
    return errorResponse("METHOD_NOT_ALLOWED", "Only GET requests are supported.", 405, { Allow: "GET" });
  }

  if (url.pathname === "/api/health") {
    return json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/years") {
    const validation = normalizeDomain(url.searchParams.get("domain") ?? "");
    if (!validation.ok) return errorResponse(validation.code, validation.message, 400);
    try {
      const indexed = await fetchIndexedYears(validation.domain, fetchImpl);
      const body: YearsResponse = {
        domain: validation.domain,
        years: indexed.years,
        truncated: indexed.truncated,
        source: "internet-archive-cdx",
        limitation: indexed.truncated
          ? "Only a bounded subset of indexed homepage records was checked; additional years may exist. Each selected year is independently verified."
          : "Only years with matching indexed homepage captures are listed. The Internet Archive has gaps; absent years do not prove the site was offline. Each selected year is independently verified.",
      };
      return json(body, { headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" } });
    } catch (error) {
      if (error instanceof ArchiveProviderError) {
        if (error.code === "ARCHIVE_RATE_LIMITED") {
          return errorResponse(error.code, error.message, 503, { "Retry-After": "60" });
        }
        return errorResponse(error.code, error.message, 502);
      }
      return errorResponse("INTERNAL_ERROR", "The archive year index could not be loaded.", 500);
    }
  }

  if (url.pathname === "/api/captures") {
    const validation = normalizeDomain(url.searchParams.get("domain") ?? "");
    if (!validation.ok) {
      return errorResponse(validation.code, validation.message, 400);
    }

    const yearValue = url.searchParams.get("year");
    let year: number | undefined;
    if (yearValue !== null) {
      const currentYear = new Date().getUTCFullYear();
      if (!/^\d{4}$/.test(yearValue) || Number(yearValue) < FIRST_ARCHIVE_YEAR || Number(yearValue) > currentYear) {
        return errorResponse(
          "INVALID_YEAR",
          `Choose a year from ${FIRST_ARCHIVE_YEAR} to ${currentYear}.`,
          400,
        );
      }
      year = Number(yearValue);
    }

    try {
      const captures =
        year === undefined
          ? await fetchCaptures(validation.domain, fetchImpl)
          : await fetchYearCaptures(validation.domain, year, fetchImpl);
      const body: CapturesResponse = {
        domain: validation.domain,
        captures,
        source: "internet-archive-cdx",
        limitation:
          year === undefined
            ? ARCHIVE_LIMITATION
            : `This is at most one surviving indexed homepage capture for ${year}. No result does not prove the site was offline.`,
      };
      return json(body, { headers: { "Cache-Control": "public, max-age=300, s-maxage=86400" } });
    } catch (error) {
      if (error instanceof ArchiveProviderError) {
        if (error.code === "ARCHIVE_RATE_LIMITED") {
          return errorResponse(error.code, error.message, 503, { "Retry-After": "60" });
        }
        return errorResponse(error.code, error.message, 502);
      }
      return errorResponse("INTERNAL_ERROR", "The request could not be completed.", 500);
    }
  }

  return errorResponse("NOT_FOUND", "API route not found.", 404);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, fetch, env);
  },
} satisfies ExportedHandler<Env>;
