import type { ApiErrorResponse, CapturesResponse } from "../shared/capture-types";
import { ArchiveProviderError, fetchCaptures, fetchYearCaptures } from "./archive-provider";
import { normalizeDomain } from "./domain-validation";

const ARCHIVE_LIMITATION =
  "Results are a small sample of surviving indexed homepage captures. Gaps do not prove the site was offline.";
const FIRST_ARCHIVE_YEAR = 1996;

export interface Env {
  BROWSER: BrowserRun;
  SCREENSHOT_ACCESS_TOKEN?: string;
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
    if (request.method !== "POST") {
      return errorResponse("METHOD_NOT_ALLOWED", "Only POST requests are supported.", 405, { Allow: "POST" });
    }
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
    if (!env.BROWSER) {
      return errorResponse(
        "SCREENSHOT_BROWSER_UNAVAILABLE",
        "The active Worker deployment cannot access the BROWSER binding. Check the production version bindings.",
        503,
      );
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
      const browserResponse = await env.BROWSER.quickAction("screenshot", {
        url: captures[0].replayUrl,
        // Hide only the Wayback UI overlay, not the archived page itself.
        // Cloudflare injects this CSS into the replay before taking the screenshot.
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
      if (!browserResponse.ok || !browserResponse.headers.get("Content-Type")?.startsWith("image/")) {
        return errorResponse("SCREENSHOT_UNAVAILABLE", "Cloudflare Browser Run could not capture this replay.", 502);
      }
      return new Response(browserResponse.body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": browserResponse.headers.get("Content-Type") ?? "image/png",
          "X-Content-Type-Options": "nosniff",
        },
      });
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
