import { describe, expect, it } from "vitest";
import {
  createOwnerSession,
  verifyOwnerSession,
  ownerSessionCookie,
  clearOwnerSessionCookie,
  OWNER_COOKIE,
  OWNER_SESSION_SECONDS,
} from "../src/worker/owner-session";
import { handleRequest } from "../src/worker/index";

const token = "a-long-unpredictable-test-only-owner-secret";
const req = (path: string, init?: RequestInit) => new Request(`https://iam.test${path}`, init);

describe("private curator sessions", () => {
  it("signs a seven-day cookie that expires and fails on tampering or token rotation", async () => {
    const now = Date.UTC(2026, 10, 2, 0, 0, 0);
    const value = await createOwnerSession(token, now);
    const request = req("/api/owner/session", { headers: { Cookie: `${OWNER_COOKIE}=${value}` } });
    expect(await verifyOwnerSession(request, token, now + 1000)).toBe(true);
    expect(await verifyOwnerSession(request, token, now + (OWNER_SESSION_SECONDS + 1) * 1000)).toBe(false);
    expect(await verifyOwnerSession(request, token + "-rotated", now + 1000)).toBe(false);
    const altered = value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
    expect(await verifyOwnerSession(req("/api/owner/session", { headers: { Cookie: `${OWNER_COOKIE}=${altered}` } }), token, now + 1000)).toBe(false);
    expect(ownerSessionCookie(value)).toContain("Secure; HttpOnly; SameSite=Strict");
    expect(clearOwnerSessionCookie()).toContain("Max-Age=0");
  });

  it("accepts a token once at login, then authorises owner screenshot requests via cookie", async () => {
    const login = await handleRequest(req("/api/owner/login", {
      method: "POST",
      headers: { Origin: "https://iam.test", "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }), async () => { throw Error("must not fetch CDX while logging in"); }, { SCREENSHOT_ACCESS_TOKEN: token });

    expect(login.status).toBe(200);
    expect(login.headers.get("cache-control")).toBe("no-store");
    const cookieHeader = login.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain(`${OWNER_COOKIE}=`);
    expect(cookieHeader).toContain("HttpOnly");
    const cookie = cookieHeader.split(";")[0];
    const session = await handleRequest(req("/api/owner/session", { headers: { Cookie: cookie } }),
      async () => { throw Error("must not fetch CDX on session lookup"); }, { SCREENSHOT_ACCESS_TOKEN: token });
    expect(await session.json()).toEqual({ authenticated: true });
    const guest = await handleRequest(req("/api/owner/session"),
      async () => { throw Error("must not fetch CDX on session lookup"); }, { SCREENSHOT_ACCESS_TOKEN: token });
    expect(await guest.json()).toEqual({ authenticated: false });

    // Without an R2 binding, this call reaches the post-auth storage guard.
    // A 503 (not 401) proves that the cookie authenticated the curator.
    const screenshot = await handleRequest(req("/api/screenshot", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://iam.test", "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "example.com", year: 2002 }),
    }), async () => { throw Error("must not fetch CDX without R2"); },
    { SCREENSHOT_ACCESS_TOKEN: token });
    expect(screenshot.status).toBe(503);
    await expect(screenshot.json()).resolves.toMatchObject({ error: { code: "SCREENSHOT_CACHE_UNAVAILABLE" } });
  });

  it("rejects bad tokens, blocks cross-origin login and generation, and supports logout", async () => {
    const invalid = await handleRequest(req("/api/owner/login", {
      method: "POST",
      headers: { Origin: "https://iam.test", "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    }), undefined, { SCREENSHOT_ACCESS_TOKEN: token });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("set-cookie")).toBeNull();

    const crossSite = await handleRequest(req("/api/owner/login", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    }), undefined, { SCREENSHOT_ACCESS_TOKEN: token });
    expect(crossSite.status).toBe(403);
    const crossSiteScreenshot = await handleRequest(req("/api/screenshot", {
      method: "POST",
      headers: { Origin: "https://attacker.example", "X-Screenshot-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "example.com", year: 2002 }),
    }), undefined, { SCREENSHOT_ACCESS_TOKEN: token });
    expect(crossSiteScreenshot.status).toBe(403);

    const logout = await handleRequest(req("/api/owner/logout", {
      method: "POST",
      headers: { Origin: "https://iam.test" },
    }), undefined, { SCREENSHOT_ACCESS_TOKEN: token });
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
