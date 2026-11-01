import type { ApiErrorResponse, CapturesResponse } from "../shared/capture-types";
import { ArchiveProviderError, fetchCaptures, fetchYearCaptures } from "./archive-provider";
import { normalizeDomain } from "./domain-validation";

const ARCHIVE_LIMITATION =
  "Results are a small sample of surviving indexed homepage captures. Gaps do not prove the site was offline.";
const FIRST_ARCHIVE_YEAR = 1996;

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

export async function handleRequest(request: Request, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);

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
  fetch(request: Request): Promise<Response> {
    return handleRequest(request);
  },
} satisfies ExportedHandler;
