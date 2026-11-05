// @vitest-environment node
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { initSharedDiscovery } from "../src/client/shared-discovery";

const first = "19990102123000";
const second = "20050102123000";

function page(path = `/discover/yahoo.com/${first}/${second}`) {
  const window = new Window({ url: `https://iam.test${path}` });
  window.document.body.innerHTML = `
    <div class="search-card"><form id="search-form"><input id="domain" /><button type="submit">Search</button></form></div>
    <section id="shared-discovery" hidden>
      <h2 id="shared-discovery-title"></h2>
      <p id="shared-discovery-status"></p>
      <div id="shared-discovery-gallery"></div>
      <p id="shared-discovery-notice"></p>
      <button id="shared-discovery-explore" hidden>Explore</button>
      <button id="shared-discovery-copy" hidden>Copy</button>
    </section>`;
  return window;
}

function api(domain = "yahoo.com", stamps = [first, second]) {
  return {
    domain, source: "r2-cached-screenshots", limitation: "Wayback replay content may differ from its indexed archive date.",
    captures: stamps.map((stamp) => ({
      year: Number(stamp.slice(0, 4)), timestamp: stamp,
      replayUrl: `https://web.archive.org/web/${stamp}/http://${domain}/`,
      screenshotUrl: `/api/screenshot?domain=${domain}&year=${stamp.slice(0, 4)}&timestamp=${stamp}`,
    })),
  };
}
async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("shareable discovery landing page", () => {
  it("loads the exact saved two-image comparison without looking up archive years or generating screenshots", async () => {
    const window = page();
    const calls: string[] = [];
    initSharedDiscovery(window.document as unknown as Document, async (input) => {
      calls.push(String(input));
      return Response.json(api());
    });
    await flush();
    expect(calls).toEqual([`/api/discovery?domain=yahoo.com&timestamp=${first}&timestamp=${second}`]);
    expect(window.document.querySelector("#shared-discovery")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector("#shared-discovery-title")?.textContent).toBe("yahoo.com — 1999 vs 2005");
    const images = window.document.querySelectorAll<HTMLImageElement>(".shared-snapshot-image");
    expect(images).toHaveLength(2);
    expect(images[0].src).toContain(`/api/screenshot?domain=yahoo.com&year=1999&timestamp=${first}`);
    expect(window.document.querySelectorAll(".shared-snapshot a")).toHaveLength(2);
    expect(window.document.querySelector("#shared-discovery-notice")?.textContent).toContain("Wayback");
    expect(window.document.querySelector("#shared-discovery-copy")?.hasAttribute("hidden")).toBe(false);
    expect(calls.some((url) => url.includes("/api/years") || url.includes("/api/screenshot/request"))).toBe(false);
  });

  it("shows a single genuine archived screenshot without an empty second panel", async () => {
    const window = page(`/discover/yahoo.com/${first}`);
    initSharedDiscovery(window.document as unknown as Document, async () => Response.json(api("yahoo.com", [first])));
    await flush();
    expect(window.document.querySelectorAll(".shared-snapshot")).toHaveLength(1);
    expect(window.document.querySelector("#shared-discovery-title")?.textContent).toBe("yahoo.com — 1999");
  });

  it("opens the website's real history search when the visitor clicks Explore", async () => {
    const window = page();
    let submissions = 0;
    window.document.querySelector("#search-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submissions++;
    });
    initSharedDiscovery(window.document as unknown as Document, async () => Response.json(api()));
    await flush();
    (window.document.querySelector("#shared-discovery-explore") as unknown as HTMLButtonElement).click();
    expect((window.document.querySelector("#domain") as unknown as HTMLInputElement).value).toBe("yahoo.com");
    expect(submissions).toBe(1);
  });

  it("rejects unexpected or malicious API data instead of rendering invented panels", async () => {
    const window = page();
    const wrong = api("yahoo.com", [first, second]);
    wrong.captures[0].replayUrl = "https://malicious.example/redirect";
    initSharedDiscovery(window.document as unknown as Document, async () => Response.json(wrong));
    await flush();
    expect(window.document.querySelectorAll(".shared-snapshot")).toHaveLength(0);
    expect(window.document.querySelector("#shared-discovery-status")?.textContent).toContain("could not be found");
    expect(window.document.querySelector("#shared-discovery-copy")?.hasAttribute("hidden")).toBe(true);
  });

  it("leaves the normal search page untouched without a discovery path", async () => {
    const window = page("/");
    let calls = 0;
    initSharedDiscovery(window.document as unknown as Document, async () => { calls++; throw Error("no API on the homepage"); });
    await flush();
    expect(calls).toBe(0);
    expect(window.document.querySelector("#shared-discovery")?.hasAttribute("hidden")).toBe(true);
  });

  it("handles a missing shared discovery with a useful explanation rather than blank images", async () => {
    const window = page();
    initSharedDiscovery(window.document as unknown as Document, async () =>
      Response.json({ error: { code: "DISCOVERY_NOT_FOUND" } }, { status: 404 }));
    await flush();
    expect(window.document.querySelectorAll(".shared-snapshot")).toHaveLength(0);
    expect(window.document.querySelector("#shared-discovery-title")?.textContent).toContain("isn't available");
    expect(window.document.querySelector("#shared-discovery-explore")?.hasAttribute("hidden")).toBe(false);
  });
});
