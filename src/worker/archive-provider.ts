import type { Capture } from "../shared/capture-types";

const CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx";
const CDX_FIELDS = ["timestamp", "original", "statuscode", "mimetype", "digest", "length"] as const;
const MAX_CAPTURES = 5;
// At most one result per adjacent CDX year group. The bound also prevents
// unbounded scans if variants/duplicates survive archive-side collapsing.
const MAX_YEAR_INDEX_RECORDS = 128;
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

export function parseCdxPayload(payload: unknown, maxCaptures = MAX_CAPTURES): Capture[] {
  if (Array.isArray(payload) && payload.length === 0) {
    return [];
  }
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) {
    return malformed("The archive returned an unexpected JSON shape.");
  }

  if (payload[0].some((field) => typeof field !== "string")) {
    return malformed("The archive returned a malformed metadata header.");
  }
  const header = payload[0] as string[];
  if (new Set(header).size !== header.length) {
    return malformed("The archive returned duplicate metadata fields.");
  }
  const indexes = Object.fromEntries(CDX_FIELDS.map((field) => [field, header.indexOf(field)])) as Record<
    (typeof CDX_FIELDS)[number],
    number
  >;
  if (CDX_FIELDS.some((field) => indexes[field] < 0)) {
    return malformed("The archive response omitted required metadata fields.");
  }

  return payload.slice(1, maxCaptures + 1).map((row) => {
    if (!Array.isArray(row) || row.length < header.length) {
      return malformed("The archive returned a malformed capture row.");
    }

    const timestamp = row[indexes.timestamp];
    const originalUrl = row[indexes.original];
    const statusCode = row[indexes.statuscode];
    const mimeType = row[indexes.mimetype];
    const digest = row[indexes.digest];
    const rawLength = row[indexes.length];

    if (
      typeof timestamp !== "string" ||
      typeof originalUrl !== "string" ||
      typeof statusCode !== "string" ||
      typeof mimeType !== "string" ||
      typeof digest !== "string" ||
      typeof rawLength !== "string"
    ) {
      return malformed("The archive returned non-text capture metadata.");
    }

    let parsedOriginal: URL;
    try {
      parsedOriginal = new URL(originalUrl);
    } catch {
      return malformed("The archive returned an invalid original URL.");
    }

    if (
      !/^\d{14}$/.test(timestamp) ||
      (parsedOriginal.protocol !== "http:" && parsedOriginal.protocol !== "https:") ||
      !parsedOriginal.hostname ||
      !/^\d{3}$/.test(statusCode) ||
      !/^[^\s/]+\/[^\s/]+$/.test(mimeType) ||
      !digest
    ) {
      return malformed("The archive returned invalid capture metadata.");
    }

    if (rawLength !== "-" && !/^\d+$/.test(rawLength)) {
      return malformed("The archive returned an invalid capture length.");
    }
    const numericLength = rawLength === "-" ? null : Number(rawLength);
    return {
      timestamp,
      originalUrl,
      statusCode,
      mimeType,
      digest,
      length: numericLength,
      replayUrl: `https://web.archive.org/web/${timestamp}/${originalUrl}`,
    };
  });
}

function createCdxUrl(domain: string, limit: number): URL {
  const url = new URL(CDX_ENDPOINT);
  url.searchParams.set("url", domain);
  url.searchParams.set("output", "json");
  url.searchParams.set("fl", CDX_FIELDS.join(","));
  url.searchParams.append("filter", "statuscode:200");
  url.searchParams.append("filter", "mimetype:text/html");
  url.searchParams.set("limit", String(limit));
  return url;
}

async function requestCaptures(url: URL, maxCaptures: number, fetchImpl: typeof fetch): Promise<Capture[]> {
  try {
    const response = await fetchImpl(url.toString(), {
      headers: {
        Accept: "application/json",
        "User-Agent": "Internet-Archaeology-Machine/0.1 (+https://github.com/LarsJansen/internet-archaeology-machine)",
      },
      redirect: "manual",
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

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ArchiveProviderError("MALFORMED_ARCHIVE_RESPONSE", "The archive returned invalid JSON.");
    }
    return parseCdxPayload(payload, maxCaptures);
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

export function fetchCaptures(domain: string, fetchImpl: typeof fetch = fetch): Promise<Capture[]> {
  return requestCaptures(createCdxUrl(domain, MAX_CAPTURES), MAX_CAPTURES, fetchImpl);
}

export function fetchYearCaptures(domain: string, year: number, fetchImpl: typeof fetch = fetch): Promise<Capture[]> {
  const url = createCdxUrl(domain, 1);
  url.searchParams.set("from", String(year));
  url.searchParams.set("to", String(year));
  return requestCaptures(url, 1, fetchImpl);
}

export interface IndexedYears {
  years: number[];
  truncated: boolean;
}

// A single bounded CDX query, rather than one request for every possible year.
// The CDX index collapses adjacent records with the same YYYY prefix; it may
// return the same year more than once for different homepage URL variants.
export async function fetchIndexedYears(
  domain: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IndexedYears> {
  const url = createCdxUrl(domain, MAX_YEAR_INDEX_RECORDS);
  url.searchParams.set("from", "1996");
  url.searchParams.set("to", String(new Date().getUTCFullYear()));
  url.searchParams.set("collapse", "timestamp:4");
  const captures = await requestCaptures(url, MAX_YEAR_INDEX_RECORDS, fetchImpl);
  const years = [...new Set(captures.map((capture) => Number(capture.timestamp.slice(0, 4))))]
    .filter((year) => year >= 1996 && year <= new Date().getUTCFullYear())
    .sort((a, b) => a - b);
  return { years, truncated: captures.length >= MAX_YEAR_INDEX_RECORDS };
}
