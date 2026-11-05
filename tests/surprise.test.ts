import { describe, expect, it } from "vitest";

import { findSurprise, SURPRISE_MAX_PAGES, SURPRISE_PAGE_SIZE } from "../src/worker/surprise";
import { screenshotKey, SCREENSHOT_VARIANT } from "../src/worker/screenshot-store";
import { handleRequest } from "../src/worker/index";

const timestamp = (year: number) => `${year}0102123000`;

function cachedObject(domain: string, year: number, changes: Record<string, string> = {}): R2Object {
  const stamp = timestamp(year);
  return {
    key: screenshotKey(domain, stamp),
    customMetadata: {
      domain,
      requestedYear: String(year),
      captureTimestamp: stamp,
      originalUrl: `http://${domain}/`,
      replayUrl: `https://web.archive.org/web/${stamp}/http://${domain}/`,
      generatedAt: "2026-11-05T01:00:00.000Z",
      rendererVersion: SCREENSHOT_VARIANT,
      renderDateVerified: "false",
      ...changes,
    },
  } as unknown as R2Object;
}

function bucket(pages: R2Objects[]) {
  const calls: R2ListOptions[] = [];
  const binding = {
    list: async (options: R2ListOptions) => {
      calls.push(options);
      return pages[Math.min(calls.length - 1, pages.length - 1)];
    },
  } as unknown as R2Bucket;
  return { binding, calls };
}
const page = (objects: R2Object[], truncated = false, cursor?: string): R2Objects => ({
  objects, truncated, ...(cursor ? { cursor } : {}), delimitedPrefixes: [],
});

describe("Surprise Me R2-only selection", () => {
  it("picks two genuinely saved years from the same website, with exact Wayback links", async () => {
    const store = bucket([page([
      cachedObject("yahoo.com", 1999),
      cachedObject("yahoo.com", 2003),
      cachedObject("mozilla.org", 2004),
    ])]);
    const result = await findSurprise(store.binding, "", () => 0);
    expect(result).toMatchObject({
      domain: "yahoo.com",
      source: "r2-cached-screenshots",
      inventoryPartial: false,
      captures: [
        { year: 1999, timestamp: timestamp(1999) },
        { year: 2003, timestamp: timestamp(2003) },
      ],
    });
    expect(result?.captures[0].replayUrl).toBe(`https://web.archive.org/web/${timestamp(1999)}/http://yahoo.com/`);
    expect(result?.captures[1].screenshotUrl).toBe(
      `/api/screenshot?domain=yahoo.com&year=2003&timestamp=${timestamp(2003)}`,
    );
    expect(result?.limitation).toContain("redirect");
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0]).toMatchObject({
      prefix: `screenshots/${SCREENSHOT_VARIANT}/`,
      limit: SURPRISE_PAGE_SIZE,
      include: ["customMetadata"],
    });
  });

  it("handles one cached screenshot without fabricating a second year", async () => {
    const store = bucket([page([cachedObject("oldweb.net", 2006)])]);
    const result = await findSurprise(store.binding, "", () => 0);
    expect(result?.domain).toBe("oldweb.net");
    expect(result?.captures).toHaveLength(1);
    expect(result?.captures[0].year).toBe(2006);
  });

  it("avoids the previous website when another eligible cached pair exists", async () => {
    const store = bucket([page([
      cachedObject("alpha.com", 2000), cachedObject("alpha.com", 2001),
      cachedObject("beta.com", 2004), cachedObject("beta.com", 2005),
    ])]);
    const result = await findSurprise(store.binding, "alpha.com", () => 0);
    expect(result?.domain).toBe("beta.com");
    expect(result?.captures).toHaveLength(2);
  });

  it("rejects malformed or malicious metadata and images from unknown storage variants", async () => {
    const externalReplay = cachedObject("bad.com", 2002, { replayUrl: "https://attacker.example/phish" });
    const wrongDate = cachedObject("bad.com", 2003, { captureTimestamp: timestamp(2004) });
    const rogueObject = { ...cachedObject("good.com", 2005), key: "screenshots/old-render/good.com/20050102123000.png" } as R2Object;
    const store = bucket([page([externalReplay, wrongDate, rogueObject])]);
    expect(await findSurprise(store.binding)).toBeNull();
  });

  it("bounds listing to three pages and explains when the inventory is partial", async () => {
    const store = bucket([
      page([cachedObject("alpha.com", 2001)], true, "next1"),
      page([cachedObject("alpha.com", 2002)], true, "next2"),
      page([cachedObject("beta.com", 2003)], true, "next3"),
      page([cachedObject("beta.com", 2004)]),
    ]);
    const result = await findSurprise(store.binding, "", () => 0);
    expect(store.calls).toHaveLength(SURPRISE_MAX_PAGES);
    expect(store.calls[1].cursor).toBe("next1");
    expect(store.calls[2].cursor).toBe("next2");
    expect(result?.inventoryPartial).toBe(true);
    expect(result?.domain).toBe("alpha.com");
    expect(result?.captures).toHaveLength(2);
  });

  it("ignores nonmatching object keys and never invents an image from an empty bucket", async () => {
    const storage = bucket([page([])]);
    expect(await findSurprise(storage.binding)).toBeNull();
  });
});

describe("Surprise Me public API", () => {
  const request = (path: string, init?: RequestInit) => new Request(`https://iam.test${path}`, init);

  it("returns only saved evidence without touching CDX or Browser Run", async () => {
    const store = bucket([page([cachedObject("yahoo.com", 1999), cachedObject("yahoo.com", 2007)])]);
    const response = await handleRequest(
      request("/api/surprise"),
      async () => { throw new Error("Surprise Me must never contact the archive"); },
      {
        SCREENSHOTS: store.binding,
        BROWSER: { quickAction: async () => { throw new Error("No Browser Run"); } } as unknown as BrowserRun,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result = await response.json() as { captures: unknown[]; domain: string };
    expect(result.domain).toBe("yahoo.com");
    expect(result.captures).toHaveLength(2);
    expect(store.calls).toHaveLength(1);
  });

  it("distinguishes an empty collection and unavailable R2 without ever starting a browser", async () => {
    const empty = bucket([page([])]);
    const noImages = await handleRequest(request("/api/surprise"), undefined, { SCREENSHOTS: empty.binding });
    expect(noImages.status).toBe(404);
    await expect(noImages.json()).resolves.toMatchObject({ error: { code: "SURPRISE_EMPTY" } });
    const unavailable = await handleRequest(request("/api/surprise"));
    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ error: { code: "SURPRISE_UNAVAILABLE" } });
  });

  it("rejects non-GET methods and reports temporary storage errors cleanly", async () => {
    const method = await handleRequest(request("/api/surprise", { method: "POST" }));
    expect(method.status).toBe(405);
    const failing = {
      list: async () => { throw new Error("R2 is down"); },
    } as unknown as R2Bucket;
    const response = await handleRequest(request("/api/surprise"), undefined, { SCREENSHOTS: failing });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "SURPRISE_UNAVAILABLE" } });
  });
});
