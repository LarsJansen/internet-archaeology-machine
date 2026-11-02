import { describe, expect, it } from "vitest";

import type { CapturesResponse } from "../src/shared/capture-types";
import fixture from "./fixtures/cdx-example.json";
import { handleRequest } from "../src/worker/index";

const request = (path: string, init?: RequestInit) => new Request(`https://iam.test${path}`, init);

const screenshotRequest = (token?: string, body: unknown = { domain: "example.com", year: 2002 }) =>
  request("/api/screenshot", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Screenshot-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });

describe("Worker API", () => {
  it("reports health without contacting the archive", async () => {
    const failFetch: typeof fetch = async () => {
      throw new Error("archive fetch must not run");
    };

    const response = await handleRequest(request("/api/health"), failFetch);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects invalid input before contacting the archive", async () => {
    const failFetch: typeof fetch = async () => {
      throw new Error("archive fetch must not run");
    };

    const response = await handleRequest(request("/api/captures?domain=localhost"), failFetch);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PRIVATE_HOST" } });
  });

  it.each(["http%3A%2F%2Fexample.com%3A80", "router.home.arpa"])(
    "rejects protected input %s before contacting the archive",
    async (domain) => {
      const failFetch: typeof fetch = async () => {
        throw new Error("archive fetch must not run");
      };

      const response = await handleRequest(request(`/api/captures?domain=${domain}`), failFetch);

      expect(response.status).toBe(400);
    },
  );

  it("returns normalized live-source capture metadata", async () => {
    const fakeFetch: typeof fetch = async () => Response.json(fixture);

    const response = await handleRequest(request("/api/captures?domain=https%3A%2F%2FExample.com%2Fpath"), fakeFetch);
    const body = (await response.json()) as CapturesResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, s-maxage=86400");
    expect(body).toMatchObject({
      domain: "example.com",
      source: "internet-archive-cdx",
    });
    expect(body.captures).toHaveLength(3);
    expect(body.captures[0]).toMatchObject({ timestamp: "20020120142510" });
  });

  it("returns a successful empty capture response when CDX has no matches", async () => {
    const fakeFetch: typeof fetch = async () => Response.json([]);

    const response = await handleRequest(request("/api/captures?domain=example.com"), fakeFetch);
    const body = (await response.json()) as CapturesResponse;

    expect(response.status).toBe(200);
    expect(body.captures).toEqual([]);
  });

  it("returns at most one capture for a valid selected year", async () => {
    const fakeFetch: typeof fetch = async () => Response.json(fixture);

    const response = await handleRequest(request("/api/captures?domain=example.com&year=2002"), fakeFetch);
    const body = (await response.json()) as CapturesResponse;

    expect(response.status).toBe(200);
    expect(body.captures).toHaveLength(1);
    expect(body.captures[0].timestamp.startsWith("2002")).toBe(true);
    expect(body.limitation).toContain("2002");
  });

  it("disables screenshots before any upstream request when the owner secret is missing", async () => {
    let archiveCalls = 0;
    let browserCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      archiveCalls += 1;
      return Response.json(fixture);
    };
    const browser = {
      quickAction: async () => {
        browserCalls += 1;
        return new Response("png", { headers: { "Content-Type": "image/png" } });
      },
    } as unknown as BrowserRun;

    const response = await handleRequest(screenshotRequest(), fakeFetch, { BROWSER: browser });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_DISABLED" } });
    expect(archiveCalls).toBe(0);
    expect(browserCalls).toBe(0);
  });

  it("reports a missing Browser Run binding only after owner authentication and before archive access", async () => {
    let archiveCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      archiveCalls += 1;
      throw new Error("must not fetch archive without browser binding");
    };

    const response = await handleRequest(screenshotRequest("owner-secret"), fakeFetch, {
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCREENSHOT_BROWSER_UNAVAILABLE" },
    });
    expect(archiveCalls).toBe(0);
  });

  it.each([undefined, "wrong-token"])(
    "rejects screenshot token %s before any upstream request",
    async (token) => {
      let archiveCalls = 0;
      let browserCalls = 0;
      const fakeFetch: typeof fetch = async () => {
        archiveCalls += 1;
        return Response.json(fixture);
      };
      const browser = {
        quickAction: async () => {
          browserCalls += 1;
          return new Response("png", { headers: { "Content-Type": "image/png" } });
        },
      } as unknown as BrowserRun;

      const response = await handleRequest(screenshotRequest(token), fakeFetch, {
        BROWSER: browser,
        SCREENSHOT_ACCESS_TOKEN: "owner-secret",
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_UNAUTHORIZED" } });
      expect(archiveCalls).toBe(0);
      expect(browserCalls).toBe(0);
    },
  );

  it("derives one verified Wayback URL and returns one Browser Run screenshot", async () => {
    let actionName = "";
    let actionOptions: BrowserRunScreenshotOptions | undefined;
    let browserCalls = 0;
    const fakeFetch: typeof fetch = async () => Response.json(fixture);
    const browser = {
      quickAction: async (action: string, options: BrowserRunScreenshotOptions) => {
        browserCalls += 1;
        actionName = action;
        actionOptions = options;
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "321" },
        });
      },
    } as unknown as BrowserRun;

    const response = await handleRequest(
      screenshotRequest("owner-secret", {
        domain: "example.com",
        year: 2002,
        url: "https://untrusted.example/",
      }),
      fakeFetch,
      { BROWSER: browser, SCREENSHOT_ACCESS_TOKEN: "owner-secret" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(browserCalls).toBe(1);
    expect(actionName).toBe("screenshot");
    expect(actionOptions).toEqual({
      url: "https://web.archive.org/web/20020120142510/http://example.com:80/",
      addStyleTag: [{ content: "#wm-ipp-base, #donato { display: none !important; }" }],
      viewport: { width: 1280, height: 900 },
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
      bestAttempt: true,
      cacheTTL: 0,
      screenshotOptions: { type: "png", fullPage: false },
    });
  });

  it("surfaces Browser Run rate limits without hiding the free-tier constraint", async () => {
    const fakeFetch: typeof fetch = async () => Response.json(fixture);
    const browser = {
      quickAction: async () =>
        Response.json(
          { errors: [{ message: "rate limited" }] },
          { status: 429, headers: { "Retry-After": "10" } },
        ),
    } as unknown as BrowserRun;

    const response = await handleRequest(screenshotRequest("owner-secret"), fakeFetch, {
      BROWSER: browser,
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("10");
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_RATE_LIMITED" } });
  });

  it("does not invoke Browser Run when the selected year has no verified capture", async () => {
    let browserCalls = 0;
    const fakeFetch: typeof fetch = async () => Response.json([]);
    const browser = {
      quickAction: async () => {
        browserCalls += 1;
        return new Response("png", { headers: { "Content-Type": "image/png" } });
      },
    } as unknown as BrowserRun;

    const response = await handleRequest(screenshotRequest("owner-secret"), fakeFetch, {
      BROWSER: browser,
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_CAPTURE_NOT_FOUND" } });
    expect(browserCalls).toBe(0);
  });

  it.each([
    [{ domain: "localhost", year: 2002 }, "PRIVATE_HOST"],
    [{ domain: "example.com", year: 1995 }, "INVALID_YEAR"],
  ])("rejects screenshot input %# before any upstream request", async (body, code) => {
    let archiveCalls = 0;
    let browserCalls = 0;
    const fakeFetch: typeof fetch = async () => {
      archiveCalls += 1;
      return Response.json(fixture);
    };
    const browser = {
      quickAction: async () => {
        browserCalls += 1;
        return new Response("png", { headers: { "Content-Type": "image/png" } });
      },
    } as unknown as BrowserRun;

    const response = await handleRequest(screenshotRequest("owner-secret", body), fakeFetch, {
      BROWSER: browser,
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(archiveCalls).toBe(0);
    expect(browserCalls).toBe(0);
  });

  it.each(["not-a-year", "1995", String(new Date().getUTCFullYear() + 1)])(
    "rejects invalid selected year %s before contacting the archive",
    async (year) => {
      const failFetch: typeof fetch = async () => {
        throw new Error("archive fetch must not run");
      };

      const response = await handleRequest(request(`/api/captures?domain=example.com&year=${year}`), failFetch);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "INVALID_YEAR" } });
    },
  );

  it.each([
    [429, 503, "ARCHIVE_RATE_LIMITED"],
    [503, 502, "ARCHIVE_UNAVAILABLE"],
  ])("maps archive HTTP %s to API HTTP %s", async (upstreamStatus, apiStatus, code) => {
    const fakeFetch: typeof fetch = async () => new Response("upstream error", { status: upstreamStatus });

    const response = await handleRequest(request("/api/captures?domain=example.com"), fakeFetch);

    expect(response.status).toBe(apiStatus);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
  });

  it("rejects unsupported API methods", async () => {
    const response = await handleRequest(request("/api/health", { method: "POST" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("returns JSON 404 for an unknown API route", async () => {
    const response = await handleRequest(request("/api/missing"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "NOT_FOUND" } });
  });
});
