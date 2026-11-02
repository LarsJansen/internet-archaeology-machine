import { describe, expect, it } from "vitest";
import {
  ScreenshotQuota, PUBLIC_DAILY_LIMIT, VISITOR_DAILY_LIMIT, CAPTURE_COOLDOWN_SECONDS,
} from "../src/worker/screenshot-budget-core";

const visitorA = "a".repeat(64);
const visitorB = "b".repeat(64);
const visitorC = "c".repeat(64);
const key = "screenshots/toolbarless-v1-1280x900/example.com/20020120142510.png";

function memoryStore() {
  const map = new Map<string, unknown>();
  const store = {
    async get<T>(name: string) { return map.get(name) as T | undefined; },
    async put<T>(name: string, value: T) { map.set(name, value); },
    async delete(name: string) { return map.delete(name); },
  };
  return { map, store };
}

describe("durable screenshot admission policy", () => {
  it("serialises concurrent reservations and blocks duplicate or different in-flight screenshots", async () => {
    let now = Date.UTC(2026, 10, 2, 8, 0, 0);
    const { store } = memoryStore();
    const budget = new ScreenshotQuota(store, () => now);
    const outcomes = await Promise.all([budget.reserve(key, visitorA, false), budget.reserve(key, visitorB, false)]);
    expect(outcomes.filter((result) => result.allowed)).toHaveLength(1);
    expect(outcomes.filter((result) => !result.allowed)).toMatchObject([{ code: "SCREENSHOT_BUSY" }]);
    const granted = outcomes.find((result) => result.allowed);
    if (!granted?.allowed) throw Error("expected a lease");
    await budget.release(granted.lease);
    expect((await budget.reserve(key, visitorB, false))).toMatchObject({ allowed: false, code: "SCREENSHOT_COOLDOWN" });
    now += CAPTURE_COOLDOWN_SECONDS * 1000;
    expect((await budget.reserve(key, visitorB, false)).allowed).toBe(true);
  });

  it("enforces two per visitor and six total per UTC day, persisted across object restarts", async () => {
    let now = Date.UTC(2026, 10, 2, 8, 0, 0);
    const { store } = memoryStore();
    const visitors = [visitorA, visitorB, visitorC];
    for (const visitor of visitors) {
      for (let i = 0; i < VISITOR_DAILY_LIMIT; i++) {
        const budget = new ScreenshotQuota(store, () => now); // Simulate DO eviction and recreation.
        const admission = await budget.reserve(key + `-${visitor}-${i}`, visitor, false);
        expect(admission.allowed).toBe(true);
        if (!admission.allowed) throw Error("missing lease");
        await budget.release(admission.lease);
        now += CAPTURE_COOLDOWN_SECONDS * 1000;
      }
    }
    expect(PUBLIC_DAILY_LIMIT).toBe(6);
    expect((await new ScreenshotQuota(store, () => now).reserve(key, visitorC, false))).toMatchObject({
      allowed: false, code: "SITE_BUDGET_EXHAUSTED",
    });
    expect((await new ScreenshotQuota(store, () => now).reserve(key, visitorA, false))).toMatchObject({
      allowed: false, code: "SITE_BUDGET_EXHAUSTED",
    });
    now += 86_400_000;
    expect((await new ScreenshotQuota(store, () => now).reserve(key, visitorA, false)).allowed).toBe(true);
  });

  it("applies the per-visitor limit before the site-wide limit when slots are left", async () => {
    let now = Date.UTC(2026, 10, 2, 8, 0, 0);
    const { store } = memoryStore();
    const budget = new ScreenshotQuota(store, () => now);
    for (let i = 0; i < VISITOR_DAILY_LIMIT; i++) {
      const admission = await budget.reserve(key, visitorA, false);
      if (!admission.allowed) throw Error("budget unavailable");
      await budget.release(admission.lease);
      now += CAPTURE_COOLDOWN_SECONDS * 1000;
    }
    expect(await budget.reserve(key, visitorA, false)).toMatchObject({
      allowed: false, code: "VISITOR_BUDGET_EXHAUSTED",
    });
    expect((await budget.reserve(key, visitorB, false)).allowed).toBe(true);
  });

  it("keeps a lease across restarts until release or a 90-second expiry, and rejects stale releases", async () => {
    let now = Date.UTC(2026, 10, 2, 8, 0, 0);
    const { store } = memoryStore();
    const first = new ScreenshotQuota(store, () => now);
    const granted = await first.reserve(key, visitorA, false);
    if (!granted.allowed) throw Error("missing lease");
    const next = new ScreenshotQuota(store, () => now);
    expect(await next.reserve(key, visitorB, false)).toMatchObject({ allowed: false, code: "SCREENSHOT_BUSY" });
    await next.release("fake-lease");
    expect(await next.reserve(key, visitorB, false)).toMatchObject({ allowed: false, code: "SCREENSHOT_BUSY" });
    now += 91_000;
    const afterLease = await next.reserve(key, visitorB, false);
    expect(afterLease.allowed).toBe(true);
    if (afterLease.allowed) await next.release(afterLease.lease);
  });

  it("lets the curator bypass the public daily cap but not the active lock and cooldown", async () => {
    let now = Date.UTC(2026, 10, 2, 8, 0, 0);
    const { store } = memoryStore();
    const budget = new ScreenshotQuota(store, () => now);
    const owner = await budget.reserve(key, null, true);
    expect(owner.allowed).toBe(true);
    expect(await budget.reserve(key, visitorA, false)).toMatchObject({ allowed: false, code: "SCREENSHOT_BUSY" });
    if (owner.allowed) await budget.release(owner.lease);
    now += CAPTURE_COOLDOWN_SECONDS * 1000;
    expect((await budget.reserve(key, null, true)).allowed).toBe(true);
  });
});
