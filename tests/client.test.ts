// @vitest-environment node
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

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

function capturePayload(year = 2002): CapturesResponse {
  return {
    domain: "example.com",
    source: "internet-archive-cdx",
    limitation: `At most one capture for ${year}.`,
    captures: [
      {
        timestamp: `${year}0120142510`,
        originalUrl: "http://example.com/",
        statusCode: "200",
        mimeType: "text/html",
        digest: "DIGEST",
        length: 1792,
        replayUrl: `https://web.archive.org/web/${year}0120142510/http://example.com/`,
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
