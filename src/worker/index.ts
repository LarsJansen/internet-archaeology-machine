import type { ApiErrorResponse, CapturesResponse } from "../shared/capture-types";
import { ArchiveProviderError, fetchCaptures } from "./archive-provider";
import { normalizeDomain } from "./domain-validation";

const ARCHIVE_LIMITATION =
  "Results are a small sample of surviving indexed homepage captures. Gaps do not prove the site was offline.";

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

    try {
      const captures = await fetchCaptures(validation.domain, fetchImpl);
      const body: CapturesResponse = {
        domain: validation.domain,
        captures,
        source: "internet-archive-cdx",
        limitation: ARCHIVE_LIMITATION,
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
