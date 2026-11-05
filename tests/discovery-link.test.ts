import { describe, expect, it } from "vitest";

import { buildDiscoveryPath, parseDiscoveryPath, isSavedDiscoveryResponse } from "../src/shared/discovery-link";
import { getSavedDiscovery } from "../src/worker/discovery";
import { screenshotKey, SCREENSHOT_VARIANT } from "../src/worker/screenshot-store";
import { handleRequest } from "../src/worker/index";

const first = "19990102123000";
const second = "20050102123000";
const request = (path: string, init?: RequestInit) => new Request(`https://iam.test${path}`, init);

function stored(domain: string, timestamp: string, overrides: Record<string, string> = {}): R2Object {
  return {
    key: screenshotKey(domain, timestamp),
    customMetadata: {
      domain,
      requestedYear: timestamp.slice(0, 4),
      captureTimestamp: timestamp,
      originalUrl: `http://${domain}/`,
      replayUrl: `https://web.archive.org/web/${timestamp}/http://${domain}/`,
      generatedAt: "2026-11-02T12:00:00Z",
      rendererVersion: SCREENSHOT_VARIANT,
      renderDateVerified: "false",
      ...overrides,
    },
  } as unknown as R2Object;
}
function cache(objects: R2Object[]) {
  const data = new Map(objects.map((object) => [object.key, object]));
  const calls: string[] = [];
  const binding = {
    head: async (key: string) => {
      calls.push(key);
      return data.get(key) ?? null;
    },
  } as unknown as R2Bucket;
  return { binding, calls };
}
function assets() {
  const calls: string[] = [];
  return {
    binding: { fetch: async (input: Request | URL | string) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response(`<!doctype html><html lang="en"><head>
        <meta name="description" content="Generic search description" />
        <title>Internet Archaeology Machine — Explore the web as it was</title>
        </head><body><main>App content<script type="module" src="/assets/main.js"></script></main></body></html>`,
      { headers: { "Content-Type": "text/html" } });
    } } as unknown as Fetcher,
    calls,
  };
}

describe("canonical discovery URLs", () => {
  it("encodes one or two exact dates in a canonical, ordered public path", () => {
    expect(buildDiscoveryPath("Yahoo.COM", [second, first])).toBe(`/discover/yahoo.com/${first}/${second}`);
    expect(buildDiscoveryPath("mozilla.org", [second])).toBe(`/discover/mozilla.org/${second}`);
    expect(parseDiscoveryPath(`/discover/yahoo.com/${first}/${second}`)).toEqual({
      domain: "yahoo.com", timestamps: [first, second],
    });
    expect(parseDiscoveryPath(`/discover/yahoo.com/${first}`)?.timestamps).toEqual([first]);
  });

  it("rejects misleading, malformed, duplicated or extra path segments", () => {
    for (const path of [
      "/discover/yahoo.com",
      `/discover/yahoo.com/${second}/${first}`,
      `/discover/yahoo.com/${first}/${first}`,
      `/discover/yahoo.com/${first}/${second}/extra`,
      "/discover/localhost/19990102123000",
      "/discover/example.com/javascript:alert(1)",
      "/discover/evil%2Fexample.com/19990102123000",
      "/discover/example.com/19990102123000%3Ffoo",
    ]) {
      expect(parseDiscoveryPath(path)).toBeNull();
    }
    expect(() => buildDiscoveryPath("example.com", [first, first])).toThrow();
    expect(() => buildDiscoveryPath("evil.com<script>", [first])).toThrow();
  });

  it("validates each returned screenshot URL against the exact original discovery", () => {
    const route = { domain: "example.com", timestamps: [first] };
    const matching = {
      domain: "example.com", source: "r2-cached-screenshots", limitation: "Wayback may redirect.",
      captures: [{
        year: 1999, timestamp: first,
        replayUrl: `https://web.archive.org/web/${first}/http://example.com/`,
        screenshotUrl: `/api/screenshot?domain=example.com&year=1999&timestamp=${first}`,
      }],
    };
    expect(isSavedDiscoveryResponse(matching, route)).toBe(true);
    expect(isSavedDiscoveryResponse({ ...matching, captures: [{ ...matching.captures[0], screenshotUrl: "https://evil.example/capture.png" }] }, route)).toBe(false);
    expect(isSavedDiscoveryResponse({ ...matching, captures: [{ ...matching.captures[0], replayUrl: "javascript:alert(1)" }] }, route)).toBe(false);
  });
});

describe("saved discovery resolver and crawler preview", () => {
  it("resolves only exact stored PNG metadata, with no archive calls or browser generation", async () => {
    const bucket = cache([stored("yahoo.com", first), stored("yahoo.com", second)]);
    const rendered = await getSavedDiscovery(bucket.binding, { domain: "yahoo.com", timestamps: [first, second] });
    expect(rendered).toMatchObject({
      source: "r2-cached-screenshots", domain: "yahoo.com",
      captures: [{ year: 1999, timestamp: first }, { year: 2005, timestamp: second }],
    });
    expect(bucket.calls).toEqual([
      screenshotKey("yahoo.com", first), screenshotKey("yahoo.com", second),
    ]);

    const pageAssets = assets();
    const env = {
      SCREENSHOTS: bucket.binding, ASSETS: pageAssets.binding,
      BROWSER: { quickAction: async () => { throw Error("Browser Run must never start"); } } as unknown as BrowserRun,
    };
    const page = await handleRequest(request(`/discover/yahoo.com/${first}/${second}`),
      async () => { throw Error("CDX must never run"); }, env);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain(`<title>yahoo.com in 1999 vs 2005 | Internet Archaeology Machine</title>`);
    expect(html).toContain('property="og:title"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain('property="og:url" content="https://iam.test/discover/yahoo.com/');
    expect(html).toContain(`property="og:image" content="https://iam.test/api/screenshot?domain=yahoo.com&amp;year=1999&amp;timestamp=${first}"`);
    expect(html).toContain('App content');
    expect(html).toContain('/assets/main.js');
    expect(html).not.toContain('SCREENSHOT_ACCESS_TOKEN');
    expect(pageAssets.calls).toEqual(["https://iam.test/"]);
  });

  it("serves metadata JSON from cached R2 heads without fetching the archive or assets", async () => {
    const store = cache([stored("mozilla.org", second)]);
    const response = await handleRequest(
      request(`/api/discovery?domain=mozilla.org&timestamp=${second}`),
      async () => { throw Error("CDX forbidden"); }, { SCREENSHOTS: store.binding },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      domain: "mozilla.org", source: "r2-cached-screenshots",
      captures: [{ year: 2005, timestamp: second }],
    });
  });

  it("returns 404 when any saved image is missing, instead of showing a partial or wrong comparison", async () => {
    const store = cache([stored("yahoo.com", first)]);
    const html = await handleRequest(request(`/discover/yahoo.com/${first}/${second}`), undefined, {
      SCREENSHOTS: store.binding, ASSETS: assets().binding,
    });
    expect(html.status).toBe(404);
    expect((await html.text())).toContain("isn't available");

    const api = await handleRequest(request(`/api/discovery?domain=yahoo.com&timestamp=${first}&timestamp=${second}`),
      undefined, { SCREENSHOTS: store.binding });
    expect(api.status).toBe(404);
    await expect(api.json()).resolves.toMatchObject({ error: { code: "DISCOVERY_NOT_FOUND" } });
  });

  it("rejects fabricated or inconsistent R2 metadata, not just missing keys", async () => {
    const store = cache([stored("yahoo.com", first, { captureTimestamp: second })]);
    expect(await getSavedDiscovery(store.binding, { domain: "yahoo.com", timestamps: [first] })).toBeNull();
    const evil = cache([stored("yahoo.com", first, { replayUrl: "https://evil.example/web/1999/" })]);
    expect(await getSavedDiscovery(evil.binding, { domain: "yahoo.com", timestamps: [first] })).toBeNull();
  });

  it("returns errors for invalid deep links, missing binding, or unsupported methods", async () => {
    expect((await handleRequest(request("/discover/yahoo.com/not-a-timestamp"))).status).toBe(404);
    expect((await handleRequest(request(`/discover/yahoo.com/${first}`))).status).toBe(503);
    expect((await handleRequest(request(`/discover/yahoo.com/${first}`, { method: "POST" }))).status).toBe(405);
    const bad = await handleRequest(request("/api/discovery?domain=localhost&timestamp=19990102123000"));
    expect(bad.status).toBe(400);
    const method = await handleRequest(request("/api/discovery", { method: "POST" }));
    expect(method.status).toBe(405);
  });

  it("supports HEAD metadata requests for social preview checks without sending HTML content", async () => {
    const storedItems = cache([stored("mozilla.org", second)]);
    const env = { SCREENSHOTS: storedItems.binding, ASSETS: assets().binding };
    const response = await handleRequest(request(`/discover/mozilla.org/${second}`, { method: "HEAD" }), undefined, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("");
  });
});
