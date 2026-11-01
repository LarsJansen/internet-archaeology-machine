import { describe, expect, it } from "vitest";

import fixture from "./fixtures/cdx-example.json";
import {
  ArchiveProviderError,
  fetchCaptures,
  parseCdxPayload,
} from "../src/worker/archive-provider";

describe("parseCdxPayload", () => {
  it("maps a real CDX response shape to capture metadata", () => {
    expect(parseCdxPayload(fixture)).toEqual([
      {
        timestamp: "20020120142510",
        originalUrl: "http://example.com:80/",
        statusCode: "200",
        mimeType: "text/html",
        digest: "HT2DYGA5UKZCPBSFVCV3JOBXGW2G5UUA",
        length: 1792,
        replayUrl: "https://web.archive.org/web/20020120142510/http://example.com:80/",
      },
      {
        timestamp: "20020328012821",
        originalUrl: "http://www.example.com:80/",
        statusCode: "200",
        mimeType: "text/html",
        digest: "UY3I2DT2AMWAY6DECFCFYMT5ZOTFHUCH",
        length: 481,
        replayUrl: "https://web.archive.org/web/20020328012821/http://www.example.com:80/",
      },
      {
        timestamp: "20020524041628",
        originalUrl: "http://www.example.com:80/",
        statusCode: "200",
        mimeType: "text/html",
        digest: "UY3I2DT2AMWAY6DECFCFYMT5ZOTFHUCH",
        length: 481,
        replayUrl: "https://web.archive.org/web/20020524041628/http://www.example.com:80/",
      },
    ]);
  });

  it("returns an empty list for a header-only response", () => {
    expect(parseCdxPayload([fixture[0]])).toEqual([]);
  });

  it.each([
    ["non-array payload", { captures: [] }],
    ["missing required header", [["timestamp", "original"]]],
    ["malformed row", [fixture[0], ["20010101000000"]]],
    ["invalid timestamp", [fixture[0], ["not-a-time", "https://example.com", "200", "text/html", "D", "1"]]],
  ])("rejects a %s", (_name, payload) => {
    expect(() => parseCdxPayload(payload)).toThrowError(ArchiveProviderError);
  });
});

describe("fetchCaptures", () => {
  it("uses the fixed CDX endpoint and a five-row exact-homepage query", async () => {
    let requestedUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json(fixture);
    };

    const captures = await fetchCaptures("example.com", fakeFetch);
    const url = new URL(requestedUrl);

    expect(url.origin + url.pathname).toBe("https://web.archive.org/cdx/search/cdx");
    expect(url.searchParams.get("url")).toBe("example.com");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.getAll("filter")).toEqual(["statuscode:200", "mimetype:text/html"]);
    expect(captures).toHaveLength(3);
  });

  it("caps an oversized response at five captures", async () => {
    const row = fixture[1];
    const fakeFetch: typeof fetch = async () => Response.json([fixture[0], row, row, row, row, row, row]);

    await expect(fetchCaptures("example.com", fakeFetch)).resolves.toHaveLength(5);
  });

  it.each([
    [429, "ARCHIVE_RATE_LIMITED"],
    [503, "ARCHIVE_UNAVAILABLE"],
  ])("maps upstream HTTP %s to %s", async (status, code) => {
    const fakeFetch: typeof fetch = async () => new Response("upstream error", { status });

    await expect(fetchCaptures("example.com", fakeFetch)).rejects.toMatchObject({ code, upstreamStatus: status });
  });
});
