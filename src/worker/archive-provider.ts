import type { Capture } from "../shared/capture-types";

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
const CDX_FIELDS = ["timestamp", "original", "statuscode", "mimetype", "digest", "length"] as const;
const MAX_CAPTURES = 5;
const REQUEST_TIMEOUT_MS = 8_000;

export type ArchiveErrorCode =
  | "ARCHIVE_RATE_LIMITED"
  | "ARCHIVE_TIMEOUT"
  | "ARCHIVE_UNAVAILABLE"
  | "MALFORMED_ARCHIVE_RESPONSE";

export class ArchiveProviderError extends Error {
  constructor(
    public readonly code: ArchiveErrorCode,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "ArchiveProviderError";
  }
}

function malformed(message: string): never {
  throw new ArchiveProviderError("MALFORMED_ARCHIVE_RESPONSE", message);
}

export function parseCdxPayload(payload: unknown): Capture[] {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return malformed("The archive returned an unexpected JSON shape.");
  }

  const header = payload[0].map(String);
  const indexes = Object.fromEntries(CDX_FIELDS.map((field) => [field, header.indexOf(field)])) as Record<
    (typeof CDX_FIELDS)[number],
    number
  >;
  if (CDX_FIELDS.some((field) => indexes[field] < 0)) {
    return malformed("The archive response omitted required metadata fields.");
  }

  return payload.slice(1, MAX_CAPTURES + 1).map((row) => {
    if (!Array.isArray(row) || row.length < header.length) {
      return malformed("The archive returned a malformed capture row.");
    }

    const timestamp = String(row[indexes.timestamp] ?? "");
    const originalUrl = String(row[indexes.original] ?? "");
    const statusCode = String(row[indexes.statuscode] ?? "");
    const mimeType = String(row[indexes.mimetype] ?? "");
    const digest = String(row[indexes.digest] ?? "");
    const rawLength = String(row[indexes.length] ?? "");

    if (!/^\d{14}$/.test(timestamp) || !/^https?:\/\//i.test(originalUrl) || !statusCode || !mimeType || !digest) {
      return malformed("The archive returned invalid capture metadata.");
    }

    const numericLength = Number(rawLength);
    return {
      timestamp,
      originalUrl,
      statusCode,
      mimeType,
      digest,
      length: Number.isFinite(numericLength) && numericLength >= 0 ? numericLength : null,
      replayUrl: `https://web.archive.org/web/${timestamp}/${originalUrl}`,
    };
  });
}

export async function fetchCaptures(domain: string, fetchImpl: typeof fetch = fetch): Promise<Capture[]> {
  const url = new URL(CDX_ENDPOINT);
  url.searchParams.set("url", domain);
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", CDX_FIELDS.join(","));
  url.searchParams.append("filter", "statuscode:200");
  url.searchParams.append("filter", "mimetype:text/html");
  url.searchParams.set("limit", String(MAX_CAPTURES));

  try {
    const response = await fetchImpl(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "Internet-Archaeology-Machine/0.1 (+https://github.com/LarsJansen/internet-archaeology-machine)",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new ArchiveProviderError("ARCHIVE_RATE_LIMITED", "The Internet Archive is rate limiting requests.", 429);
      }
      throw new ArchiveProviderError(
        "ARCHIVE_UNAVAILABLE",
        `The Internet Archive returned HTTP ${response.status}.`,
        response.status,
      );
    }

    return parseCdxPayload(await response.json());
  } catch (error) {
    if (error instanceof ArchiveProviderError) {
      throw error;
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ArchiveProviderError("ARCHIVE_TIMEOUT", "The Internet Archive request timed out.");
    }
    throw new ArchiveProviderError("ARCHIVE_UNAVAILABLE", "The Internet Archive could not be reached.");
  }
}
