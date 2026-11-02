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

function createBucket() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  return {
    objects,
    binding: {
      async get(key: string) {
        const item = objects.get(key);
        if (!item) return null;
        return {
          body: new Response(item.bytes.slice()).body,
          customMetadata: item.metadata,
        } as R2ObjectBody;
      },
      async put(key: string, data: ArrayBuffer, options?: { customMetadata?: Record<string, string> }) {
        objects.set(key, {
          bytes: new Uint8Array(data.slice(0)),
          metadata: options?.customMetadata ?? {},
        });
        return {} as R2Object;
      },
    } as unknown as R2Bucket,
  };
}

describe("Worker API", () => {
  const publicRequest = (body: unknown = { domain: "example.com", year: 2002, timestamp: "20020120142510" }, headers: Record<string, string> = {}) =>
    request("/api/screenshot/request", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10", Origin: "https://iam.test", ...headers },
      body: JSON.stringify(body),
    });

  function publicEnv(
    bucket: ReturnType<typeof createBucket>,
    override: {
      reserve?: (key: string, visitor: string | null, owner: boolean) => Promise<unknown>;
      quickAction?: () => Promise<Response>;
    } = {},
  ) {
    const activity = { reserve: 0, release: 0, browsers: 0, keys: [] as string[], visitors: [] as string[] };
    const gate = {
      reserve: async (key: string, visitor: string | null, owner: boolean) => {
        activity.reserve++;
        activity.keys.push(key);
        activity.visitors.push(visitor ?? "");
        expect(owner).toBe(false);
        return override.reserve?.(key, visitor, owner) ?? { allowed: true, lease: "lease-1" };
      },
      release: async (lease: string) => { expect(lease).toBe("lease-1"); activity.release++; },
    };
    const env = {
      SCREENSHOTS: bucket.binding,
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
      PUBLIC_SCREENSHOTS_ENABLED: "true",
      SCREENSHOT_BUDGET: { getByName: () => gate },
      BROWSER: {
        quickAction: async () => {
          activity.browsers++;
          return override.quickAction?.() ?? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
        },
      },
    } as unknown as Parameters<typeof handleRequest>[2];
    return { env, activity };
  }

  it("lets a visitor generate a missing screenshot once and serves its saved R2 result", async () => {
    const bucket = createBucket();
    const { env, activity } = publicEnv(bucket);
    const first = await handleRequest(publicRequest(), async () => Response.json(fixture), env);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-iam-screenshot-source")).toBe("generated");
    expect(activity.reserve).toBe(1);
    expect(activity.release).toBe(1);
    expect(activity.browsers).toBe(1);
    expect(activity.visitors[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(activity.keys[0]).toContain("example.com/20020120142510.png");
    const second = await handleRequest(publicRequest(), async () => { throw Error("no new CDX"); }, env);
    expect(second.status).toBe(200);
    expect(second.headers.get("x-iam-screenshot-source")).toBe("cached");
    expect(activity.reserve).toBe(1);
    expect(activity.browsers).toBe(1);
  });

  it("never starts a browser without a configured durable budget", async () => {
    const bucket = createBucket();
    let browsers = 0;
    const response = await handleRequest(publicRequest(), async () => { throw Error("no CDX"); }, {
      SCREENSHOTS: bucket.binding,
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
      PUBLIC_SCREENSHOTS_ENABLED: "true",
      BROWSER: { quickAction: async () => { browsers++; throw Error("unsafe"); } } as unknown as BrowserRun,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "PUBLIC_SCREENSHOTS_UNAVAILABLE" } });
    expect(browsers).toBe(0);
  });

  it("honours site and visitor quotas, busy leases and cooldowns without contacting the archive", async () => {
    for (const code of ["SITE_BUDGET_EXHAUSTED", "VISITOR_BUDGET_EXHAUSTED", "SCREENSHOT_BUSY", "SCREENSHOT_COOLDOWN"]) {
      const { env, activity } = publicEnv(createBucket(), {
        reserve: async () => ({ allowed: false, code, retryAfter: 30 }),
      });
      const response = await handleRequest(publicRequest(), async () => { throw Error("CDX must not be called"); }, env);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("30");
      await expect(response.json()).resolves.toMatchObject({ error: { code } });
      expect(activity.browsers).toBe(0);
      expect(activity.release).toBe(0);
    }
  });

  it("rejects a false archive timestamp even if the requested year matches", async () => {
    const { env, activity } = publicEnv(createBucket());
    const response = await handleRequest(
      publicRequest({ domain: "example.com", year: 2002, timestamp: "20021231120000" }),
      async () => Response.json(fixture), env,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_CAPTURE_CHANGED" } });
    expect(activity.browsers).toBe(0);
    expect(activity.release).toBe(1);
  });

  it("does not allow public browsers to generate for malformed inputs, cross-site requests or unverified IPs", async () => {
    const { env, activity } = publicEnv(createBucket());
    const invalid = [
      publicRequest({ domain: "localhost", year: 2002, timestamp: "20020120142510" }),
      publicRequest({ domain: "example.com", year: 2002, timestamp: "20190120142510" }),
      publicRequest({ domain: "example.com", year: 1995, timestamp: "19950120142510" }),
      publicRequest(undefined, { Origin: "https://attacker.example" }),
      publicRequest(undefined, { "Content-Type": "text/plain" }),
      publicRequest(undefined, { "CF-Connecting-IP": "" }),
    ];
    for (const attempt of invalid) {
      const response = await handleRequest(attempt, async () => { throw Error("must not fetch CDX"); }, env);
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(activity.browsers).toBe(0);
    expect(activity.reserve).toBe(0);
  });

  it("releases the global lease when Browser Run fails so other visitors can retry", async () => {
    const { env, activity } = publicEnv(createBucket(), { quickAction: async () => { throw Error("render failed"); } });
    const response = await handleRequest(publicRequest(), async () => Response.json(fixture), env);
    expect(response.status).toBe(502);
    expect(activity.release).toBe(1);
  });


  it("allows anyone to fetch a stored screenshot by exact archive timestamp without Browser Run or CDX", async () => {
    const bucket = createBucket();
    const png = new Uint8Array([137, 80, 78, 71]);
    const key = "screenshots/toolbarless-v1-1280x900/example.com/20020120142510.png";
    bucket.objects.set(key, { bytes: png, metadata: { requestedYear: "2002" } });
    let archiveCalls = 0;
    const failFetch: typeof fetch = async () => {
      archiveCalls += 1;
      throw new Error("Public cache reads must not contact the Internet Archive");
    };
    const response = await handleRequest(
      request("/api/screenshot?domain=example.com&year=2002&timestamp=20020120142510"),
      failFetch,
      { SCREENSHOTS: bucket.binding },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-iam-screenshot-source")).toBe("cached");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
    expect(archiveCalls).toBe(0);
  });

  it("returns a real 404 on a missing screenshot and rejects invalid cache keys", async () => {
    const bucket = createBucket();
    const noArchive: typeof fetch = async () => { throw new Error("no upstream"); };
    const missing = await handleRequest(
      request("/api/screenshot?domain=example.com&year=2002&timestamp=20020120142510"),
      noArchive, { SCREENSHOTS: bucket.binding },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_NOT_CACHED" } });
    const mismatched = await handleRequest(
      request("/api/screenshot?domain=example.com&year=2002&timestamp=20190120142510"),
      noArchive, { SCREENSHOTS: bucket.binding },
    );
    expect(mismatched.status).toBe(400);
  });

  it("reuses a saved screenshot for owner requests without starting the browser", async () => {
    const bucket = createBucket();
    const png = new Uint8Array([137, 80, 78, 71]);
    const key = "screenshots/toolbarless-v1-1280x900/example.com/20020120142510.png";
    bucket.objects.set(key, { bytes: png, metadata: {} });
    const response = await handleRequest(screenshotRequest("owner-secret"), async () => Response.json(fixture), {
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
      SCREENSHOTS: bucket.binding,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-iam-screenshot-source")).toBe("cached");
  });

  it("generates once, saves original capture provenance, then serves it publicly", async () => {
    const bucket = createBucket();
    let browserCalls = 0;
    const browser = {
      quickAction: async () => {
        browserCalls++;
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      },
    } as unknown as BrowserRun;
    const first = await handleRequest(screenshotRequest("owner-secret"), async () => Response.json(fixture), {
      BROWSER: browser, SCREENSHOT_ACCESS_TOKEN: "owner-secret", SCREENSHOTS: bucket.binding,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("x-iam-screenshot-source")).toBe("generated");
    const key = "screenshots/toolbarless-v1-1280x900/example.com/20020120142510.png";
    expect(bucket.objects.get(key)?.metadata).toMatchObject({
      domain: "example.com", requestedYear: "2002", captureTimestamp: "20020120142510",
      rendererVersion: "toolbarless-v1-1280x900", renderDateVerified: "false",
    });
    const second = await handleRequest(screenshotRequest("owner-secret"), async () => Response.json(fixture), {
      BROWSER: browser, SCREENSHOT_ACCESS_TOKEN: "owner-secret", SCREENSHOTS: bucket.binding,
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("x-iam-screenshot-source")).toBe("cached");
    expect(browserCalls).toBe(1);
  });

  it("fails closed when R2 is not attached instead of using Browser Run without persistence", async () => {
    let browserCalls = 0;
    const browser = { quickAction: async () => { browserCalls++; throw Error("should not render"); } } as unknown as BrowserRun;
    const response = await handleRequest(screenshotRequest("owner-secret"), async () => Response.json(fixture), {
      BROWSER: browser, SCREENSHOT_ACCESS_TOKEN: "owner-secret",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_CACHE_UNAVAILABLE" } });
    expect(browserCalls).toBe(0);
  });


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

  it("discovers sparse indexed years with one bounded collapsed CDX request", async () => {
    const observed: string[] = [];
    const header = ["timestamp", "original", "statuscode", "mimetype", "digest", "length"];
    const row = (year: number) => [
      `${year}0101120000`, "http://late.example/", "200", "text/html", `digest${year}`, "120",
    ];
    const fakeFetch: typeof fetch = async (input) => {
      observed.push(String(input));
      return Response.json([header, row(2023), row(2025), row(2025), row(2026)]);
    };
    const response = await handleRequest(request("/api/years?domain=late.example"), fakeFetch);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      domain: "late.example",
      years: [2023, 2025, 2026],
      truncated: false,
      source: "internet-archive-cdx",
    });
    expect(observed).toHaveLength(1);
    const url = new URL(observed[0]);
    expect(url.searchParams.get("url")).toBe("late.example");
    expect(url.searchParams.get("collapse")).toBe("timestamp:4");
    expect(url.searchParams.get("limit")).toBe("128");
    expect(url.searchParams.get("from")).toBe("1996");
    expect(url.searchParams.get("to")).toBe(String(new Date().getUTCFullYear()));
    expect(url.searchParams.getAll("filter")).toEqual(["statuscode:200", "mimetype:text/html"]);
  });

  it("does not fabricate indexed years when CDX returns no matching records", async () => {
    const response = await handleRequest(
      request("/api/years?domain=unused.example"),
      async () => Response.json([]),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      years: [], truncated: false,
    });
  });

  it("distinguishes failed index access from empty archive coverage", async () => {
    const response = await handleRequest(
      request("/api/years?domain=example.com"),
      async () => Response.json({ problem: "busy" }, { status: 429 }),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "ARCHIVE_RATE_LIMITED" } });
  });

  it("validates year-index domains without contacting the archive", async () => {
    const noFetch: typeof fetch = async () => { throw Error("should not contact CDX"); };
    const response = await handleRequest(request("/api/years?domain=localhost"), noFetch);
    expect(response.status).toBe(400);
  });

  it("marks a bounded index as truncated when the returned record limit is reached", async () => {
    const header = ["timestamp", "original", "statuscode", "mimetype", "digest", "length"];
    const rows = Array.from({length: 128}, (_, i) => [
      `2020${String(i % 12 + 1).padStart(2, "0")}01120000`,
      "http://example.com/", "200", "text/html", `digest${i}`, "100",
    ]);
    const response = await handleRequest(request("/api/years?domain=example.com"), async () => Response.json([header, ...rows]));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ years: [2020], truncated: true });
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
      return Response.json(fixture);
    };

    const response = await handleRequest(screenshotRequest("owner-secret"), fakeFetch, {
      SCREENSHOT_ACCESS_TOKEN: "owner-secret",
      SCREENSHOTS: createBucket().binding,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "SCREENSHOT_BROWSER_UNAVAILABLE" },
    });
    expect(archiveCalls).toBe(1);
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
      SCREENSHOTS: createBucket().binding,
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
      { BROWSER: browser, SCREENSHOT_ACCESS_TOKEN: "owner-secret", SCREENSHOTS: createBucket().binding },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("public");
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
      SCREENSHOTS: createBucket().binding,
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
      SCREENSHOTS: createBucket().binding,
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
      SCREENSHOTS: createBucket().binding,
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
