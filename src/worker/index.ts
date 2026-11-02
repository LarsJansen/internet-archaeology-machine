import type { ApiErrorResponse, CapturesResponse, YearsResponse } from "../shared/capture-types";
import { ArchiveProviderError, fetchCaptures, fetchYearCaptures, fetchIndexedYears } from "./archive-provider";
import { normalizeDomain } from "./domain-validation";
import { screenshotImage, screenshotKey, screenshotMetadata } from "./screenshot-store";
import { createOwnerSession, verifyOwnerSession, ownerSessionCookie, clearOwnerSessionCookie, hasValidRequestOrigin } from "./owner-session";
import { ScreenshotBudget } from "./screenshot-budget";

export { ScreenshotBudget };

const ARCHIVE_LIMITATION =
  "Results are a small sample of surviving indexed homepage captures. Gaps do not prove the site was offline.";
const FIRST_ARCHIVE_YEAR = 1996;

export interface Env {
  BROWSER: BrowserRun;
  SCREENSHOT_ACCESS_TOKEN?: string;
  SCREENSHOTS?: R2Bucket;
  SCREENSHOT_BUDGET?: DurableObjectNamespace<ScreenshotBudget>;
  PUBLIC_SCREENSHOTS_ENABLED?: string;
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

async function renderAndSave(
  env: Partial<Env>, domain: string, year: number,
  capture: Awaited<ReturnType<typeof fetchYearCaptures>>[number], key: string,
): Promise<Response> {
  if (!env.BROWSER) {
    return errorResponse("SCREENSHOT_BROWSER_UNAVAILABLE", "Screenshot rendering is temporarily unavailable.", 503);
  }
  if (!env.SCREENSHOTS) {
    return errorResponse("SCREENSHOT_CACHE_UNAVAILABLE", "Screenshot storage is temporarily unavailable.", 503);
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
      "SCREENSHOT_RATE_LIMITED", "The screenshot service is busy. Please try again later.",
      429, { "Retry-After": browserResponse.headers.get("Retry-After") ?? "60" },
    );
  }
  if (!browserResponse.ok || !browserResponse.headers.get("Content-Type")?.startsWith("image/png")) {
    return errorResponse("SCREENSHOT_UNAVAILABLE", "The archived page could not be captured. Try another year.", 502);
  }
  const png = await browserResponse.arrayBuffer();
  if (png.byteLength === 0 || png.byteLength > 8 * 1024 * 1024) {
    return errorResponse("SCREENSHOT_UNAVAILABLE", "The screenshot image was empty or too large.", 502);
  }
  try {
    await env.SCREENSHOTS.put(key, png, {
      httpMetadata: { contentType: "image/png" },
      customMetadata: screenshotMetadata(domain, year, capture),
    });
  } catch {
    return errorResponse("SCREENSHOT_STORAGE_ERROR", "The screenshot could not be saved. Try again later.", 503);
  }
  return screenshotImage(png, "generated");
}

async function visitorFingerprint(request: Request, secret: string): Promise<string | null> {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip.length > 64) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode("iam-public-generation:" + ip)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleRequest(
  request: Request,
  fetchImpl: typeof fetch = fetch,
  env: Partial<Env> = {},
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/owner/session") {
    if (request.method !== "GET") return errorResponse("METHOD_NOT_ALLOWED", "Only GET is supported.", 405);
    const authenticated = !!env.SCREENSHOT_ACCESS_TOKEN && await verifyOwnerSession(request, env.SCREENSHOT_ACCESS_TOKEN);
    return json({ authenticated }, { headers: { "Cache-Control": "no-store" } });
  }

  if (url.pathname === "/api/owner/login") {
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported.", 405);
    if (!hasValidRequestOrigin(request)) return errorResponse("INVALID_ORIGIN", "Cross-origin owner requests are not permitted.", 403);
    if (!env.SCREENSHOT_ACCESS_TOKEN) return errorResponse("SCREENSHOT_DISABLED", "Owner access is not configured.", 503);
    let payload: unknown;
    try { payload = await request.json(); } catch { return errorResponse("INVALID_LOGIN", "Enter your owner access token.", 400); }
    if (!payload || typeof payload !== "object" || typeof (payload as { token?: unknown }).token !== "string") {
      return errorResponse("INVALID_LOGIN", "Enter your owner access token.", 400);
    }
    if (!(await tokensMatch((payload as { token: string }).token, env.SCREENSHOT_ACCESS_TOKEN))) {
      return errorResponse("OWNER_UNAUTHORIZED", "Incorrect owner token.", 401);
    }
    const session = await createOwnerSession(env.SCREENSHOT_ACCESS_TOKEN);
    return json({ authenticated: true }, {
      headers: { "Cache-Control": "no-store", "Set-Cookie": ownerSessionCookie(session) },
    });
  }

  if (url.pathname === "/api/owner/logout") {
    if (request.method !== "POST") return errorResponse("METHOD_NOT_ALLOWED", "Only POST is supported.", 405);
    if (!hasValidRequestOrigin(request)) return errorResponse("INVALID_ORIGIN", "Cross-origin owner requests are not permitted.", 403);
    return json({ authenticated: false }, {
      headers: { "Cache-Control": "no-store", "Set-Cookie": clearOwnerSessionCookie() },
    });
  }

  if (url.pathname === "/api/screenshot/request") {
    if (request.method !== "POST") {
      return errorResponse("METHOD_NOT_ALLOWED", "Only POST requests are supported.", 405, { Allow: "POST" });
    }
    if (!hasValidRequestOrigin(request)) {
      return errorResponse("INVALID_ORIGIN", "Screenshot requests must come from this website.", 403);
    }
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Submit a valid JSON screenshot request.", 400);
    }
    const size = Number(request.headers.get("Content-Length") ?? 0);
    if (size > 1024) {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "The screenshot request is too large.", 413);
    }
    let payload: unknown;
    try { payload = await request.json(); } catch {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Submit a domain, year and archive timestamp.", 400);
    }
    if (!payload || typeof payload !== "object") {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Submit a domain, year and archive timestamp.", 400);
    }
    const candidate = payload as { domain?: unknown; year?: unknown; timestamp?: unknown };
    if (typeof candidate.domain !== "string" || typeof candidate.year !== "number" || typeof candidate.timestamp !== "string") {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Submit a domain, year and archive timestamp.", 400);
    }
    const validated = normalizeDomain(candidate.domain);
    if (!validated.ok) return errorResponse(validated.code, validated.message, 400);
    if (
      !Number.isInteger(candidate.year) || candidate.year < FIRST_ARCHIVE_YEAR ||
      candidate.year > new Date().getUTCFullYear() ||
      !/^\d{14}$/.test(candidate.timestamp) || !candidate.timestamp.startsWith(String(candidate.year))
    ) {
      return errorResponse("INVALID_SCREENSHOT_REQUEST", "Choose a valid indexed capture year and timestamp.", 400);
    }
    if (!env.SCREENSHOTS) return errorResponse("SCREENSHOT_CACHE_UNAVAILABLE", "Screenshot storage is temporarily unavailable.", 503);
    const key = screenshotKey(validated.domain, candidate.timestamp);
    try {
      const stored = await env.SCREENSHOTS.get(key);
      if (stored) return screenshotImage(stored.body, "cached");
    } catch {
      return errorResponse("SCREENSHOT_STORAGE_ERROR", "Screenshot storage is temporarily unavailable.", 503);
    }
    if (env.PUBLIC_SCREENSHOTS_ENABLED !== "true") {
      return errorResponse("PUBLIC_SCREENSHOTS_DISABLED", "New public screenshot requests are temporarily paused.", 503);
    }
    if (!env.SCREENSHOT_BUDGET || !env.BROWSER || !env.SCREENSHOT_ACCESS_TOKEN) {
      return errorResponse("PUBLIC_SCREENSHOTS_UNAVAILABLE", "New screenshot requests are temporarily unavailable.", 503);
    }
    const visitor = await visitorFingerprint(request, env.SCREENSHOT_ACCESS_TOKEN);
    if (!visitor) {
      return errorResponse("VISITOR_UNVERIFIED", "We could not verify this visitor request. Try again later.", 403);
    }

    let lease: string;
    const gate = env.SCREENSHOT_BUDGET.getByName("public-screenshot-gate-v1");
    try {
      const admission = await gate.reserve(key, visitor, false);
      if (!admission.allowed) {
        const messages: Record<string, string> = {
          SITE_BUDGET_EXHAUSTED: "Today's public screenshot allowance is full. Saved screenshots are still available.",
          VISITOR_BUDGET_EXHAUSTED: "You've reached today's screenshot allowance. Try again tomorrow.",
          SCREENSHOT_BUSY: "Another screenshot is being captured. Try again shortly.",
          SCREENSHOT_COOLDOWN: "Screenshots are being spaced out to protect the archive. Try again shortly.",
        };
        return errorResponse(admission.code, messages[admission.code], 429, {
          "Retry-After": String(admission.retryAfter),
        });
      }
      lease = admission.lease;
    } catch {
      return errorResponse("PUBLIC_SCREENSHOTS_UNAVAILABLE", "Screenshot limits are temporarily unavailable.", 503);
    }

    try {
      // Recheck after acquiring the global lease: another visitor may have saved
      // exactly this capture between our first R2 read and admission.
      const existing = await env.SCREENSHOTS.get(key);
      if (existing) return screenshotImage(existing.body, "cached");

      const captures = await fetchYearCaptures(validated.domain, candidate.year, fetchImpl);
      if (captures.length === 0) {
        return errorResponse("SCREENSHOT_CAPTURE_NOT_FOUND", "No verified homepage capture is available for that year.", 404);
      }
      if (captures[0].timestamp !== candidate.timestamp) {
        return errorResponse(
          "SCREENSHOT_CAPTURE_CHANGED",
          "The archive's selected capture has changed. Check this year again before requesting a screenshot.",
          409,
        );
      }
      return await renderAndSave(env, validated.domain, candidate.year, captures[0], key);
    } catch (error) {
      if (error instanceof ArchiveProviderError) {
        if (error.code === "ARCHIVE_RATE_LIMITED") return errorResponse(error.code, error.message, 503, { "Retry-After": "60" });
        return errorResponse(error.code, error.message, 502);
      }
      return errorResponse("SCREENSHOT_UNAVAILABLE", "The archived page could not be captured. Try another year.", 502);
    } finally {
      try { await gate.release(lease); } catch { /* Lease times out after 90 seconds even after failures. */ }
    }
  }

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
    if (!hasValidRequestOrigin(request)) {
      return errorResponse("INVALID_ORIGIN", "Cross-origin owner requests are not permitted.", 403);
    }
    const hasOwnerSession = await verifyOwnerSession(request, env.SCREENSHOT_ACCESS_TOKEN);
    const hasLegacyOwnerToken = await tokensMatch(request.headers.get("X-Screenshot-Token"), env.SCREENSHOT_ACCESS_TOKEN);
    if (!hasOwnerSession && !hasLegacyOwnerToken) {
      return errorResponse("SCREENSHOT_UNAUTHORIZED", "Sign in as the owner to generate new screenshots.", 401);
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
      return await renderAndSave(env, validation.domain, candidate.year, capture, key);
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
