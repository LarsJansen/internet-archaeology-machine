// @vitest-environment node
import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vitest";

import type { CapturesResponse } from "../src/shared/capture-types";
import { formatCaptureTimestamp, initSearch } from "../src/client/main";

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
      <ol id="year-list"></ol>
      <section id="selected-capture" hidden>
        <h3 id="capture-heading"></h3>
        <ul id="capture-list"></ul>
        <div id="screenshot-controls">
          <label for="screenshot-token">Owner screenshot token</label>
          <input id="screenshot-token" type="password" autocomplete="off" />
        </div>
        <section id="screenshot-result" hidden>
          <p id="screenshot-caption"></p>
          <img id="screenshot-image" />
        </section>
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
  it("shows every year as not checked without making an archive request", async () => {
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
    expect(yearButtons).toHaveLength(new Date().getUTCFullYear() - 1996 + 1);
    expect(yearButtons[0].getAttribute("data-year")).toBe("1996");
    expect(yearButtons[0].textContent).toContain("Not checked");
    expect(window.document.querySelector("#status")?.textContent).toBe("Choose one year to check for example.com.");
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
    expect(window.document.querySelector('[data-year="2003"]')?.textContent).toContain("Not checked");
    resolveResponse(Response.json(capturePayload()));
    await pendingClick;
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

  it("sends the owner token in a header and renders one screenshot for a verified capture", async () => {
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
    (window.document.querySelector("#screenshot-token") as unknown as HTMLInputElement).value = "owner-secret";

    await clickScreenshot(window, 2002);

    expect(screenshotRequest?.method).toBe("POST");
    expect(screenshotRequest?.headers.get("x-screenshot-token")).toBe("owner-secret");
    await expect(screenshotRequest?.json()).resolves.toEqual({ domain: "example.com", year: 2002 });
    expect((window.document.querySelector("#screenshot-token") as unknown as HTMLInputElement).value).toBe("");
    const image = window.document.querySelector("#screenshot-image") as unknown as HTMLImageElement;
    expect(image.src).toMatch(/^blob:/);
    expect(image.alt).toBe("Screenshot of the archived example.com homepage capture from 2002");
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
      (window.document.querySelector("#screenshot-token") as unknown as HTMLInputElement).value = "owner-secret";

      await clickScreenshot(window, 2002);

      expect(window.document.querySelector("#screenshot-result")?.hasAttribute("hidden")).toBe(false);
      expect(window.document.querySelector("#status")?.textContent).toBe(
        "Screenshot captured for example.com in 2002.",
      );
    },
  );

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
    const tokenInput = window.document.querySelector("#screenshot-token") as unknown as HTMLInputElement;
    tokenInput.value = "owner-secret";

    await clickScreenshot(window, 2002);
    tokenInput.value = "owner-secret";
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
    (window.document.querySelector("#screenshot-token") as unknown as HTMLInputElement).value = "owner-secret";
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
    (window.document.querySelector("#screenshot-token") as unknown as HTMLInputElement).value = "owner-secret";

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
      requestCount += 1;
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
      requestCount += 1;
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
      requestCount += 1;
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
      requestCount += 1;
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
    expect(window.document.querySelector('[data-year="2003"]')?.textContent).toContain("Not checked");
    expect(window.document.querySelector("#status")?.textContent).toBe(message);
  });
});
