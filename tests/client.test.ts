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
      <button type="submit">Search</button>
    </form>
    <p id="status" role="status"></p>
    <section id="results" hidden>
      <h2 id="results-heading"></h2>
      <ul id="capture-list"></ul>
    </section>
  `;
  return window;
}

async function submit(window: Window) {
  const form = window.document.querySelector("#search-form");
  form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("formatCaptureTimestamp", () => {
  it("formats a CDX timestamp as an explicit UTC date", () => {
    expect(formatCaptureTimestamp("20020120142510")).toBe("20 Jan 2002 at 14:25 UTC");
  });

  it("leaves an unexpected timestamp visible instead of inventing a date", () => {
    expect(formatCaptureTimestamp("not-a-time")).toBe("not-a-time");
  });
});

describe("domain search interface", () => {
  it("shows a loading state while the archive request is pending", async () => {
    const window = createPage();
    let resolveResponse!: (response: Response) => void;
    const fakeFetch: typeof fetch = () => new Promise((resolve) => (resolveResponse = resolve));
    initSearch(window.document as unknown as Document, fakeFetch);
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";

    const pendingSubmit = submit(window);

    expect(window.document.querySelector("#status")?.textContent).toBe("Searching the archive index…");
    expect((window.document.querySelector("button") as unknown as HTMLButtonElement).disabled).toBe(true);
    resolveResponse(Response.json({ domain: "example.com", captures: [], source: "internet-archive-cdx", limitation: "" }));
    await pendingSubmit;
  });

  it("renders live-source captures as safe Wayback links", async () => {
    const window = createPage();
    const payload: CapturesResponse = {
      domain: "example.com",
      source: "internet-archive-cdx",
      limitation: "Archive coverage is incomplete.",
      captures: [
        {
          timestamp: "20020120142510",
          originalUrl: "http://example.com/",
          statusCode: "200",
          mimeType: "text/html",
          digest: "DIGEST",
          length: 1792,
          replayUrl: "https://web.archive.org/web/20020120142510/http://example.com/",
        },
      ],
    };
    initSearch(window.document as unknown as Document, async () => Response.json(payload));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";

    await submit(window);

    const link = window.document.querySelector("#capture-list a") as unknown as HTMLAnchorElement;
    expect(window.document.querySelector("#status")?.textContent).toBe("1 capture found for example.com.");
    expect(link?.textContent).toBe("20 Jan 2002 at 14:25 UTC");
    expect(link?.href).toBe(payload.captures[0].replayUrl);
    expect(link?.rel).toContain("noreferrer");
    expect(window.document.querySelector("#results")?.hasAttribute("hidden")).toBe(false);
  });

  it("shows an honest empty state", async () => {
    const window = createPage();
    const payload: CapturesResponse = {
      domain: "example.com",
      source: "internet-archive-cdx",
      limitation: "Archive coverage is incomplete.",
      captures: [],
    };
    initSearch(window.document as unknown as Document, async () => Response.json(payload));
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";

    await submit(window);

    expect(window.document.querySelector("#status")?.textContent).toBe(
      "No indexed homepage captures were returned for example.com.",
    );
    expect(window.document.querySelector("#results")?.hasAttribute("hidden")).toBe(true);
  });

  it("shows an explicit API error without fixture fallback", async () => {
    const window = createPage();
    initSearch(
      window.document as unknown as Document,
      async () => Response.json({ error: { code: "ARCHIVE_RATE_LIMITED", message: "Try again later." } }, { status: 503 }),
    );
    (window.document.querySelector("#domain") as unknown as HTMLInputElement).value = "example.com";

    await submit(window);

    expect(window.document.querySelector("#status")?.textContent).toBe("Try again later.");
    expect(window.document.querySelector("#capture-list")?.children).toHaveLength(0);
  });
});
