// @vitest-environment node
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import type { CapturesResponse } from "../src/shared/capture-types";
import { formatCaptureTimestamp, initSearch as initActualSearch } from "../src/client/main";

// Existing interaction tests assume a few indexed years; wrap the new
// discovery request so those tests can continue focusing on their own APIs.
function initSearch(document: Document, fetchImpl: typeof fetch = fetch): void {
  const access = document.createElement("div");
  access.innerHTML = `<form id="owner-login-form"><input id="owner-login-token" type="password" /></form>
    <div id="owner-signed-in" hidden></div><button id="owner-logout-button"></button><p id="owner-auth-status"></p>`;
  document.body.append(access);
  initActualSearch(document, ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/owner/session" ? Response.json({ authenticated: true }) :
    String(input).startsWith("/api/years?")
      ? Response.json({
          domain: "example.com",
          years: [1996, 2002, 2003, 2004],
          source: "internet-archive-cdx",
          truncated: false,
          limitation: "Only indexed homepage years are shown.",
        })
      : fetchImpl(input, init)) as typeof fetch);
}

function createPage() {
  const window = new Window({ url: "https://iam.test" });
  window.document.body.innerHTML = `
    <form id="search-form">
      <label for="domain">Domain</label>
      <input id="domain" name="domain" />
      <button type="submit">Explore years</button>
    </form>
    <p id="status" role="status"></p>
    <section id="results" hidden>
      <h2 id="results-heading"></h2>
      <p class="timeline-note"></p>
      <ol id="year-list"></ol>
      <section id="selected-capture" hidden>
        <h3 id="capture-heading"></h3>
        <ul id="capture-list"></ul>
        <div id="owner-tools" hidden>Curator tools</div>
        <section id="comparison-gallery" hidden>
          <article id="image-panel-first" hidden>
            <h4 id="visual-year-first"></h4>
            <div id="visual-placeholder-first"></div>
            <section id="screenshot-result" hidden>
              <p id="screenshot-caption"></p>
              <img id="screenshot-image" />
            </section>
          </article>
          <article id="image-panel-second" hidden>
            <h4 id="visual-year-second"></h4>
            <div id="visual-placeholder-second"></div>
            <section id="screenshot-result-second" hidden>
              <p id="screenshot-caption-second"></p>
              <img id="screenshot-image-second" />
            </section>
          </article>
        </section>
        <div id="share-card-actions" hidden>
          <button id="download-discovery" disabled>Download PNG</button>
          <button id="copy-discovery-sources">Copy sources</button>
        </div>
      </section>
    </section>
  `;
  return window;
}

async function submit(window: Window) {
  const form = window.document.querySelector("#search-form");
  form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function clickYear(window: Window, year: number) {
  const button = window.document.querySelector(`[data-year="${year}"]`);
  button?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function replaceYear(window: Window, year: number) {
  const button = window.document.querySelector(`[data-replace-year="${year}"]`);
  button?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function clickScreenshot(window: Window, year: number) {
  const button = window.document.querySelector(`[data-screenshot-year="${year}"]`);
  button?.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function capturePayload(year = 2002, domain = "example.com"): CapturesResponse {
  return {
    domain,
    source: "internet-archive-cdx",
    limitation: `At most one capture for ${year}.`,
    captures: [
      {
        timestamp: `${year}0120142510`,
        originalUrl: `http://${domain}/`,
        statusCode: "200",
        mimeType: "text/html",
        digest: "DIGEST",
        length: 1792,
        replayUrl: `https://web.archive.org/web/${year}0120142510/http://${domain}/`,
      },
    ],
  };
}

describe("formatCaptureTimestamp", () => {
  it("formats a CDX timestamp as an explicit UTC date", () => {
    expect(formatCaptureTimestamp("20020120142510")).toBe("20 Jan 2002 at 14:25 UTC");
  });

  it("leaves an unexpected timestamp visible instead of inventing a date", () => {
    expect(formatCaptureTimestamp("not-a-time")).toBe("not-a-time");
  });
});

describe("on-demand year explorer", () => {
  it("shows only indexed years without fetching every year separately", async () => {
    const window = createPage();
    let requestCount = 0;
    const fakeFetch: typeof fetch = async () => {
      requestCount += 1;
      throw new Error("year fetch must not run on form submit");
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";

    await submit(window);

    const yearButtons = window.document.querySelectorAll("#year-list button");
    expect(requestCount).toBe(0);
    expect(yearButtons).toHaveLength(4);
    expect(yearButtons[0].getAttribute("data-year")).toBe("1996");
    expect(yearButtons[0].textContent).toContain("In archive index");
    expect(window.document.querySelector("#status")?.textContent).toBe("Found 4 indexed years for example.com. Select a year to verify its capture.");
  });

  it("checks only the selected year and shows a pending state", async () => {
    const window = createPage();
    let requestedUrl = "";
    let requestCount = 0;
    let resolveResponse!: (response: Response) => void;
    const fakeFetch: typeof fetch = (input) => {
      requestCount += 1;
      requestedUrl = String(input);
      return new Promise((resolve) => (resolveResponse = resolve));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);

    const pendingClick = clickYear(window, 2002);
    await clickYear(window, 2003);
    const selectedButton = window.document.querySelector('[data-year="2002"]');

    expect(requestCount).toBe(1);
    expect(requestedUrl).toBe("/api/captures?domain=example.com&year=2002");
    expect(selectedButton?.textContent).toContain("Checking…");
    expect((selectedButton as unknown as HTMLButtonElement).disabled).toBe(true);
    expect(window.document.querySelector('[data-year="2003"]')?.textContent).toContain("In archive index");
    resolveResponse(Response.json(capturePayload()));
    await pendingClick;
  });

  it("loads saved screenshots for public visitors without a token or Browser Run request", async () => {
    const window = createPage();
    const requested: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      requested.push(String(input));
      if (String(input).startsWith("/api/screenshot?")) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png", "X-IAM-Screenshot-Source": "cached" },
        });
      }
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickYear(window, 2003);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requested.filter((url) => url.startsWith("/api/screenshot?"))).toEqual([
      "/api/screenshot?domain=example.com&year=2002&timestamp=20020120142510",
      "/api/screenshot?domain=example.com&year=2003&timestamp=20030120142510",
    ]);
    expect(requested).not.toContain("/api/screenshot");
    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector("#screenshot-result-second")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')).toBeNull();
  });

  it("shows only the actual indexed years for a late-launch website", async () => {
    const window = createPage();
    const requests: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      requests.push(String(input));
      if (String(input).startsWith("/api/years?")) {
        return Response.json({
          domain: "youngsite.example",
          years: [2024, 2026],
          source: "internet-archive-cdx",
          truncated: false,
          limitation: "Only matching indexed years are listed.",
        });
      }
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year, "youngsite.example"));
    };
    initActualSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "youngsite.example";
    await submit(window);
    expect(Array.from(window.document.querySelectorAll("#year-list button")).map((button) => button.getAttribute("data-year"))).toEqual(["2024", "2026"]);
    expect(window.document.querySelector('[data-year="1996"]')).toBeNull();
    expect(window.document.querySelector("#capture-list")?.children).toHaveLength(0);
    expect(requests).toHaveLength(1);
    await clickYear(window, 2024);
    expect(window.document.querySelectorAll("#capture-list li")).toHaveLength(1);
    expect(requests.filter((url) => url.startsWith("/api/captures?"))).toHaveLength(1);
  });

  it("shows an honest empty index without inventing a 1996 timeline", async () => {
    const window = createPage();
    initActualSearch(window.document as unknown as Document, async () => Response.json({
      domain: "notindexed.example",
      years: [],
      source: "internet-archive-cdx",
      truncated: false,
      limitation: "No evidence is not proof of no website.",
    }));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "notindexed.example";
    await submit(window);
    expect(window.document.querySelectorAll("#year-list button")).toHaveLength(0);
    expect(window.document.querySelector("#results")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector("#status")?.textContent).toContain("does not prove the site was offline");
  });

  it("does not mistake an archive index failure for no historical captures", async () => {
    const window = createPage();
    initActualSearch(window.document as unknown as Document, async () =>
      Response.json({ error: { code: "ARCHIVE_RATE_LIMITED", message: "The Internet Archive is rate limiting requests." } }, { status: 503 }));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    expect(window.document.querySelector("#status")?.textContent).toBe("The Internet Archive is rate limiting requests.");
    expect(window.document.querySelector("#results")?.hasAttribute("hidden")).toBe(true);
    expect(window.document.querySelectorAll("#year-list button")).toHaveLength(0);
  });

  it("states when the bounded year index may have been truncated", async () => {
    const window = createPage();
    initActualSearch(window.document as unknown as Document, async () => Response.json({
      domain: "example.com",
      years: [2019, 2020],
      source: "internet-archive-cdx",
      truncated: true,
      limitation: "Only a bounded subset was checked; additional years may exist.",
    }));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    expect(window.document.querySelector(".timeline-note")?.textContent).toContain("additional years may exist");
    expect(window.document.querySelectorAll("#year-list button")).toHaveLength(2);
  });

  it("renders a verified capture as a safe Wayback link", async () => {
    const window = createPage();
    const payload = capturePayload();
    initSearch(window.document as unknown as Document, async () => Response.json(payload));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);

    await clickYear(window, 2002);

    const link = window.document.querySelector("#capture-list a") as unknown as HTMLAnchorElement;
    expect(window.document.querySelector('[data-year="2002"]')?.textContent).toContain("Capture found");
    expect(window.document.querySelector("#status")?.textContent).toBe("Capture found for example.com in 2002.");
    expect(link.textContent).toBe("20 Jan 2002 at 14:25 UTC");
    expect(link.href).toBe(payload.captures[0].replayUrl);
    expect(link.rel).toContain("noreferrer");
    expect(window.document.querySelector("#selected-capture")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows a public on-demand screenshot button but does not generate automatically", async () => {
    const window = createPage();
    const requests: string[] = [];
    initActualSearch(window.document as unknown as Document, async (input) => {
      requests.push(String(input));
      if (String(input).startsWith("/api/years?")) {
        return Response.json({ domain: "example.com", source: "internet-archive-cdx",
          years: [2002, 2003], truncated: false, limitation: "Indexed years only." });
      }
      const url = new URL(String(input), "https://iam.test");
      if (url.pathname === "/api/screenshot") return Response.json({ error: { code: "SCREENSHOT_NOT_CACHED" } }, { status: 404 });
      return Response.json(capturePayload(Number(url.searchParams.get("year"))));
    });
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    expect(window.document.querySelector("#owner-tools")?.hasAttribute("hidden")).toBe(true);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')?.textContent).toContain("Show this snapshot");
    expect(requests.some((url) => url === "/api/screenshot/request")).toBe(false);
  });

  it("signs in a curator once, changes generation controls, and restores public controls on logout", async () => {
    const window = createPage();
    const access = window.document.createElement("div");
    access.innerHTML = `<form id="owner-login-form"><input id="owner-login-token" type="password" /></form>
    <div id="owner-signed-in" hidden></div><button id="owner-logout-button"></button><p id="owner-auth-status"></p>`;
    window.document.body.append(access);
    const calls: string[] = [];
    initActualSearch(window.document as unknown as Document, async (input, init) => {
      calls.push(String(input));
      if (String(input) === "/api/owner/session") return Response.json({ authenticated: false });
      if (String(input) === "/api/owner/login") return Response.json({ authenticated: true });
      if (String(input) === "/api/owner/logout") return Response.json({ authenticated: false });
      if (String(input).startsWith("/api/years?")) {
        return Response.json({ domain: "example.com", source: "internet-archive-cdx",
          years: [2002], truncated: false, limitation: "Indexed years only." });
      }
      const url = new URL(String(input), "https://iam.test");
      if (url.pathname === "/api/screenshot") return Response.json({ error: { code: "SCREENSHOT_NOT_CACHED" } }, { status: 404 });
      return Response.json(capturePayload(2002));
    });
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')?.textContent).toContain("Show this snapshot");
    const input = window.document.querySelector("#owner-login-token") as unknown as HTMLInputElement;
    input.value = "test-owner-token";
    window.document.querySelector("#owner-login-form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain("/api/owner/login");
    expect(input.value).toBe("");
    expect(window.document.querySelector("#owner-tools")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')?.textContent).toContain("Save missing screenshot");
    (window.document.querySelector("#owner-logout-button") as unknown as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toContain("/api/owner/logout");
    expect(window.document.querySelector('[data-screenshot-year="2002"]')?.textContent).toContain("Show this snapshot");
    expect(window.document.querySelector("#owner-tools")?.hasAttribute("hidden")).toBe(true);
  });

  it("requests public screenshot generation with the verified CDX timestamp, never an owner token", async () => {
    const window = createPage();
    let requestBody: unknown;
    const requests: string[] = [];
    initActualSearch(window.document as unknown as Document, async (input, init) => {
      requests.push(String(input));
      if (String(input) === "/api/owner/session") return Response.json({ authenticated: false });
      if (String(input).startsWith("/api/years?")) {
        return Response.json({ domain: "example.com", years: [2002], source: "internet-archive-cdx", truncated: false, limitation: "Indexed years." });
      }
      if (String(input) === "/api/screenshot/request") {
        requestBody = JSON.parse(String(init?.body));
        expect(new Headers(init?.headers).has("x-screenshot-token")).toBe(false);
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      }
      if (String(input).startsWith("/api/screenshot?")) {
        return Response.json({ error: { code: "SCREENSHOT_NOT_CACHED" } }, { status: 404 });
      }
      return Response.json(capturePayload(2002));
    });
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    expect(requests).not.toContain("/api/screenshot/request");
    await clickScreenshot(window, 2002);
    expect(requestBody).toEqual({ domain: "example.com", year: 2002, timestamp: "20020120142510" });
    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')).toBeNull();
  });

  it("shows an honest daily-budget error without hiding the verified archive record", async () => {
    const window = createPage();
    initActualSearch(window.document as unknown as Document, async (input) => {
      if (String(input) === "/api/owner/session") return Response.json({ authenticated: false });
      if (String(input).startsWith("/api/years?")) {
        return Response.json({ domain: "example.com", years: [2002], source: "internet-archive-cdx", truncated: false, limitation: "Indexed years." });
      }
      if (String(input) === "/api/screenshot/request") return Response.json(
        { error: { code: "SITE_BUDGET_EXHAUSTED", message: "Today's public screenshot allowance is full. Saved screenshots are still available." } },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
      if (String(input).startsWith("/api/screenshot?")) return Response.json({ error: { code: "SCREENSHOT_NOT_CACHED" } }, { status: 404 });
      return Response.json(capturePayload(2002));
    });
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickScreenshot(window, 2002);
    expect(window.document.querySelector("#status")?.textContent).toContain("allowance is full");
    expect(window.document.querySelector("#capture-list")?.children).toHaveLength(1);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')).not.toBeNull();
  });

  it("shows PNG sharing only after two real captures are selected", async () => {
    const window = createPage();
    initSearch(window.document as unknown as Document, async (input) => {
      if (String(input).startsWith("/api/screenshot?")) {
        return Response.json({ error: { code: "SCREENSHOT_NOT_CACHED" } }, { status: 404 });
      }
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    });
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    expect(window.document.querySelector("#share-card-actions")?.hasAttribute("hidden")).toBe(true);
    await clickYear(window, 2002);
    expect(window.document.querySelector("#share-card-actions")?.hasAttribute("hidden")).toBe(true);
    await clickYear(window, 2003);
    expect(window.document.querySelector("#share-card-actions")?.hasAttribute("hidden")).toBe(false);
    expect((window.document.querySelector("#download-discovery") as unknown as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the signed owner session instead of resending the private token for each screenshot", async () => {
    const window = createPage();
    let screenshotRequest: Request | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input) === "/api/screenshot") {
        screenshotRequest = new Request("https://iam.test/api/screenshot", init);
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      }
      return Response.json(capturePayload(2002));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickScreenshot(window, 2002);

    expect(screenshotRequest?.method).toBe("POST");
    expect(screenshotRequest?.headers.has("x-screenshot-token")).toBe(false);
    await expect(screenshotRequest?.json()).resolves.toEqual({ domain: "example.com", year: 2002 });
    expect(screenshotRequest?.credentials).toBe("same-origin");
    const image = window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement;
    expect(image.src).toMatch(/^blob:/);
    expect(image.alt).toBe("Wayback replay screenshot requested for example.com in 2002; the replay may redirect to a different archived date");
    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelectorAll("#capture-list li")).toHaveLength(1);
  });

  it.each(["https://Example.com/path", "EXAMPLE.COM"])(
    "keeps a screenshot requested from normalized domain input %s",
    async (domainInput) => {
      const window = createPage();
      const fakeFetch: typeof fetch = async (input) => {
        if (String(input) === "/api/screenshot") {
          return new Response(new Uint8Array([137]), { headers: { "Content-Type": "image/png" } });
        }
        return Response.json(capturePayload(2002, "example.com"));
      };
      initSearch(window.document as unknown as Document, fakeFetch);
      (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = domainInput;
      await submit(window);
      await clickYear(window, 2002);

      await clickScreenshot(window, 2002);

      expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(false);
      expect(window.document.querySelector("#status")?.textContent).toBe(
        "New snapshot saved for everyone: example.com in 2002.",
      );
    },
  );

  it("renders two independently requested screenshots side by side without background browser requests", async () => {
    const window = createPage();
    const screenshotYears: number[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input) === "/api/screenshot") {
        const payload = JSON.parse(String(init?.body)) as { year: number };
        screenshotYears.push(payload.year);
        return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
      }
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickYear(window, 2003);
    expect(screenshotYears).toEqual([]);
    expect(window.document.querySelector("#comparison-gallery")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(true);
    expect(window.document.querySelector("#screenshot-result-second")?.hasAttribute("hidden")).toBe(true);

    await clickScreenshot(window, 2002);
    const firstSrc = (window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement).src;
    expect(firstSrc).toMatch(/^blob:/);
    expect(window.document.querySelector("#screenshot-result-second")?.hasAttribute("hidden")).toBe(true);
    await clickScreenshot(window, 2003);

    const secondImage = window.document.querySelector("#screenshot-image-second") as unknown as HTMLImageElement;
    expect(secondImage.src).toMatch(/^blob:/);
    expect(secondImage.src).not.toBe(firstSrc);
    expect((window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement).src).toBe(firstSrc);
    expect(secondImage.alt).toContain("2003");
    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector("#screenshot-result-second")?.hasAttribute("hidden")).toBe(false);
    expect(screenshotYears).toEqual([2002, 2003]);
    expect(window.document.querySelector('[data-screenshot-year="2002"]')).toBeNull();
  });

  it("reuses an in-tab screenshot when its year is reselected and revokes both URLs on domain change", async () => {
    const window = createPage();
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    let screenshotCalls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      if (String(input) === "/api/screenshot") {
        screenshotCalls += 1;
        return new Response(new Uint8Array([137]), { headers: { "Content-Type": "image/png" } });
      }
      const url = new URL(String(input), "https://iam.test");
      return Response.json(capturePayload(Number(url.searchParams.get("year")), url.searchParams.get("domain") ?? ""));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    const domain = window.document.querySelector("#domain") as unknown as HTMLInputElement;
    domain.value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickYear(window, 2003);
    await clickScreenshot(window, 2002);
    const firstUrl = (window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement).src;
    await clickScreenshot(window, 2003);
    const secondUrl = (window.document.querySelector("#screenshot-image-second") as unknown as HTMLImageElement).src;

    await replaceYear(window, 2002);
    expect((window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement).src).toBe(secondUrl);
    await clickYear(window, 2002);
    expect((window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement).src).toBe(secondUrl);
    expect((window.document.querySelector("#screenshot-image-second") as unknown as HTMLImageElement).src).toBe(firstUrl);
    expect(screenshotCalls).toBe(2);

    domain.value = "mozilla.org";
    await submit(window);
    expect(revokeSpy).toHaveBeenCalledWith(firstUrl);
    expect(revokeSpy).toHaveBeenCalledWith(secondUrl);
    expect(window.document.querySelector("#comparison-gallery")?.hasAttribute("hidden")).toBe(true);
    revokeSpy.mockRestore();
  });

  it("allows only one screenshot request while an image is pending", async () => {
    const window = createPage();
    let screenshotCalls = 0;
    let resolveScreenshot!: (response: Response) => void;
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input) === "/api/screenshot") {
        screenshotCalls += 1;
        return new Promise((resolve) => (resolveScreenshot = resolve));
      }
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickYear(window, 2003);

    await clickScreenshot(window, 2002);
    await clickScreenshot(window, 2003);

    expect(screenshotCalls).toBe(1);
    expect(window.document.querySelector("#status")?.textContent).toBe("Capturing the 2002 Wayback replay…");
    expect(
      (window.document.querySelector('[data-screenshot-year="2003"]') as unknown as HTMLButtonElement).disabled,
    ).toBe(true);
    resolveScreenshot(new Response(new Uint8Array([137]), { headers: { "Content-Type": "image/png" } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("revokes and clears the screenshot when the domain changes", async () => {
    const window = createPage();
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL");
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input) === "/api/screenshot") {
        return new Response(new Uint8Array([137]), { headers: { "Content-Type": "image/png" } });
      }
      const url = new URL(String(input), "https://iam.test");
      return Response.json(capturePayload(Number(url.searchParams.get("year")), url.searchParams.get("domain") ?? ""));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    const domainInput = window.document.querySelector("#domain") as unknown as HTMLInputElement;
    domainInput.value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickScreenshot(window, 2002);
    const image = window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement;
    const screenshotUrl = image.src;

    domainInput.value = "mozilla.org";
    await submit(window);

    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(true);
    expect(image.hasAttribute("src")).toBe(false);
    expect(revokeSpy).toHaveBeenCalledWith(screenshotUrl);
    revokeSpy.mockRestore();
  });

  it("shows a screenshot rate-limit error without removing verified metadata", async () => {
    const window = createPage();
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input) === "/api/screenshot") {
        return Response.json(
          { error: { code: "SCREENSHOT_RATE_LIMITED", message: "Cloudflare Browser Run is rate limited." } },
          { status: 429 },
        );
      }
      return Response.json(capturePayload(2002));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);

    await clickScreenshot(window, 2002);

    expect(window.document.querySelector("#status")?.textContent).toBe("Cloudflare Browser Run is rate limited.");
    expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(true);
    expect(window.document.querySelectorAll("#capture-list li")).toHaveLength(1);
  });

  it("retains two verified captures for side-by-side comparison", async () => {
    const window = createPage();
    const fakeFetch: typeof fetch = async (input) => {
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);

    await clickYear(window, 2002);
    await clickYear(window, 2003);

    const captureItems = window.document.querySelectorAll("#capture-list li");
    const links = window.document.querySelectorAll("#capture-list a");
    expect(captureItems).toHaveLength(2);
    expect(links[0].textContent).toContain("2002");
    expect(links[1].textContent).toContain("2003");
    expect((links[0] as unknown as HTMLAnchorElement).rel).toContain("noreferrer");
    expect((links[1] as unknown as HTMLAnchorElement).rel).toContain("noreferrer");
  });

  it("does not silently displace either capture when a third year is verified", async () => {
    const window = createPage();
    let requestCount = 0;
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input).startsWith("/api/captures?")) requestCount += 1;
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);

    await clickYear(window, 2002);
    await clickYear(window, 2003);
    await clickYear(window, 2004);

    expect(requestCount).toBe(3);
    expect(window.document.querySelectorAll("#capture-list li")).toHaveLength(2);
    expect(window.document.querySelector('[data-replace-year="2002"]')).not.toBeNull();
    expect(window.document.querySelector('[data-replace-year="2003"]')).not.toBeNull();
    expect(window.document.querySelector('[data-replace-year="2004"]')).toBeNull();
    expect(window.document.querySelector("#status")?.textContent).toContain("Replace either year");
  });

  it("replaces either comparison capture and reuses verified years without refetching", async () => {
    const window = createPage();
    let requestCount = 0;
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input).startsWith("/api/captures?")) requestCount += 1;
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickYear(window, 2003);

    await replaceYear(window, 2002);
    expect(window.document.activeElement?.getAttribute("data-year")).toBe("2002");
    await clickYear(window, 2004);

    expect(requestCount).toBe(3);
    expect(window.document.querySelectorAll("#capture-list li")).toHaveLength(2);
    expect(window.document.querySelector('[data-replace-year="2003"]')).not.toBeNull();
    expect(window.document.querySelector('[data-replace-year="2004"]')).not.toBeNull();

    await replaceYear(window, 2004);
    await clickYear(window, 2002);

    expect(requestCount).toBe(3);
    expect(window.document.querySelector('[data-replace-year="2002"]')).not.toBeNull();
    expect(window.document.querySelector('[data-replace-year="2003"]')).not.toBeNull();
  });

  it("keeps replacement controls unavailable until an outstanding year check finishes", async () => {
    const window = createPage();
    let requestCount = 0;
    let resolvePending!: (response: Response) => void;
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input).startsWith("/api/captures?")) requestCount += 1;
      const year = Number(new URL(String(input), "https://iam.test").searchParams.get("year"));
      if (requestCount === 3) {
        return new Promise((resolve) => (resolvePending = resolve));
      }
      return Response.json(capturePayload(year));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);
    await clickYear(window, 2002);
    await clickYear(window, 2003);

    await clickYear(window, 2004);
    const replaceButton = window.document.querySelector(
      '[data-replace-year="2002"]',
    ) as unknown as HTMLButtonElement;

    expect(replaceButton.disabled).toBe(true);
    replaceButton.click();
    expect(window.document.querySelector('[data-replace-year="2002"]')).not.toBeNull();

    resolvePending(Response.json(capturePayload(2004)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replaceButton.disabled).toBe(false);
    replaceButton.click();
    expect(window.document.activeElement?.getAttribute("data-year")).toBe("2002");
  });

  it("clears compared captures and checked-year cache when the domain changes", async () => {
    const window = createPage();
    let requestCount = 0;
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input).startsWith("/api/captures?")) requestCount += 1;
      const url = new URL(String(input), "https://iam.test");
      const year = Number(url.searchParams.get("year"));
      const domain = url.searchParams.get("domain") ?? "";
      return Response.json(capturePayload(year, domain));
    };
    initSearch(window.document as unknown as Document, fakeFetch);
    const input = window.document.querySelector("#domain") as unknown as HTMLInputElement;
    input.value = "example.com";
    await submit(window);
    await clickYear(window, 2002);

    input.value = "mozilla.org";
    await submit(window);

    expect(window.document.querySelector("#capture-list")?.children).toHaveLength(0);
    expect(window.document.querySelector("#selected-capture")?.hasAttribute("hidden")).toBe(true);
    await clickYear(window, 2002);
    expect(requestCount).toBe(2);
    expect(window.document.querySelector("#capture-heading")?.textContent).toContain("mozilla.org");
  });

  it("marks a checked year with no returned capture", async () => {
    const window = createPage();
    const payload: CapturesResponse = {
      domain: "example.com",
      source: "internet-archive-cdx",
      limitation: "No result does not prove the site was offline.",
      captures: [],
    };
    initSearch(window.document as unknown as Document, async () => Response.json(payload));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);

    await clickYear(window, 1996);

    expect(window.document.querySelector('[data-year="1996"]')?.textContent).toContain("No capture returned");
    expect(window.document.querySelector("#status")?.textContent).toBe(
      "No indexed homepage capture was returned for example.com in 1996.",
    );
    expect(window.document.querySelector("#selected-capture")?.hasAttribute("hidden")).toBe(true);
  });

  it.each([
    ["ARCHIVE_TIMEOUT", "The Internet Archive request timed out."],
    ["ARCHIVE_RATE_LIMITED", "The Internet Archive is rate limiting requests."],
    ["ARCHIVE_UNAVAILABLE", "The Internet Archive could not be reached."],
  ])("shows the %s year-check error without changing other years", async (code, message) => {
    const window = createPage();
    initSearch(
      window.document as unknown as Document,
      async () => Response.json({ error: { code, message } }, { status: code === "ARCHIVE_RATE_LIMITED" ? 503 : 502 }),
    );
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";
    await submit(window);

    await clickYear(window, 2002);

    expect(window.document.querySelector('[data-year="2002"]')?.textContent).toContain("Check failed");
    expect(window.document.querySelector('[data-year="2003"]')?.textContent).toContain("In archive index");
    expect(window.document.querySelector("#status")?.textContent).toBe(message);
  });
});
