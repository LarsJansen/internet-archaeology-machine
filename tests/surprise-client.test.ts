// @vitest-environment node
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { initSurprise } from "../src/client/surprise";

const stamp = (year: number) => `${year}0102123000`;
function sample(domain: string, years: number[]) {
  return {
    domain, source: "r2-cached-screenshots", inventoryPartial: false,
    limitation: "Replay dates are not independently verified.",
    captures: years.map((year) => ({
      year,
      timestamp: stamp(year),
      replayUrl: `https://web.archive.org/web/${stamp(year)}/http://${domain}/`,
      screenshotUrl: `/api/screenshot?domain=${domain}&year=${year}&timestamp=${stamp(year)}`,
    })),
  };
}

function page() {
  const window = new Window({ url: "https://iam.test" });
  window.document.body.innerHTML = `
    <div class="search-card">
      <form id="search-form"><input id="domain" type="text" /><button type="submit">Explore</button></form>
    </div>
    <button id="surprise-trigger" type="button" aria-expanded="false">Surprise me</button>
    <section id="surprise-result" hidden>
      <h2 id="surprise-title"></h2><p id="surprise-status"></p>
      <div id="surprise-gallery"></div><p id="surprise-caveat"></p>
      <button id="surprise-explore" hidden>Explore this site</button>
      <button id="surprise-again">Find another</button>
    </section>
  `;
  return window;
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Surprise Me browser experience", () => {
  it("reveals real cached screenshots with archived timestamps and links, without generating any", async () => {
    const window = page();
    const calls: string[] = [];
    initSurprise(window.document as unknown as Document, async (input) => {
      calls.push(String(input));
      return Response.json(sample("yahoo.com", [1999, 2005]));
    });
    expect(window.document.querySelector("#surprise-result")?.hasAttribute("hidden")).toBe(true);
    (window.document.querySelector("#surprise-trigger") as unknown as HTMLButtonElement).click();
    await flush();

    expect(calls).toEqual(["/api/surprise"]);
    expect(window.document.querySelector("#surprise-result")?.hasAttribute("hidden")).toBe(false);
    expect(window.document.querySelector("#surprise-title")?.textContent).toBe("yahoo.com");
    expect(window.document.querySelectorAll(".surprise-snapshot")).toHaveLength(2);
    const images = Array.from(window.document.querySelectorAll<HTMLImageElement>(".surprise-image"));
    expect(images[0].src).toContain("/api/screenshot?domain=yahoo.com&year=1999&timestamp=");
    expect(images[1].alt).toContain("2005");
    expect(window.document.querySelector("#surprise-gallery")?.textContent).toContain("1999-01-02");
    const anchors = window.document.querySelectorAll<HTMLAnchorElement>(".surprise-source");
    expect(anchors).toHaveLength(2);
    expect(anchors[0].href).toContain("web.archive.org/web/");
    expect(anchors[0].rel).toContain("noreferrer");
    expect(calls.every((url) => url.startsWith("/api/surprise"))).toBe(true);
    expect(window.document.querySelector("#surprise-explore")?.hasAttribute("hidden")).toBe(false);
  });

  it("finds another cached website without immediately repeating the same domain", async () => {
    const window = page();
    const calls: string[] = [];
    initSurprise(window.document as unknown as Document, async (input) => {
      calls.push(String(input));
      return Response.json(calls.length === 1 ? sample("yahoo.com", [2000]) : sample("mozilla.org", [2001]));
    });
    (window.document.querySelector("#surprise-trigger") as unknown as HTMLButtonElement).click();
    await flush();
    expect(window.document.querySelectorAll(".surprise-snapshot")).toHaveLength(1);
    expect(window.document.querySelector("#surprise-status")?.textContent).toContain("One saved snapshot");

    (window.document.querySelector("#surprise-again") as unknown as HTMLButtonElement).click();
    await flush();
    expect(calls).toEqual(["/api/surprise", "/api/surprise?exclude=yahoo.com"]);
    expect(window.document.querySelector("#surprise-title")?.textContent).toBe("mozilla.org");
  });

  it("explores a discovered site's timeline without making a screenshot-generation request", async () => {
    const window = page();
    let submitted = 0;
    window.document.querySelector("#search-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      submitted++;
    });
    initSurprise(window.document as unknown as Document, async () => Response.json(sample("oldweb.net", [2002, 2009])));
    (window.document.querySelector("#surprise-trigger") as unknown as HTMLButtonElement).click();
    await flush();
    (window.document.querySelector("#surprise-explore") as unknown as HTMLButtonElement).click();
    expect((window.document.querySelector("#domain") as unknown as HTMLInputElement).value).toBe("oldweb.net");
    expect(submitted).toBe(1);
  });

  it("explains empty cache without showing made-up panels or automatically generating screenshots", async () => {
    const window = page();
    const calls: string[] = [];
    initSurprise(window.document as unknown as Document, async (input) => {
      calls.push(String(input));
      return Response.json({
        error: { code: "SURPRISE_EMPTY", message: "There aren't any saved snapshots to discover yet." },
      }, { status: 404 });
    });
    (window.document.querySelector("#surprise-trigger") as unknown as HTMLButtonElement).click();
    await flush();
    expect(window.document.querySelector("#surprise-title")?.textContent).toBe("Not this time");
    expect(window.document.querySelector("#surprise-status")?.textContent).toContain("aren't any saved snapshots");
    expect(window.document.querySelectorAll(".surprise-snapshot")).toHaveLength(0);
    expect(window.document.querySelector("#surprise-explore")?.hasAttribute("hidden")).toBe(true);
    expect(calls).toEqual(["/api/surprise"]);
  });

  it("rejects a malformed backend payload without injecting attacker-provided links", async () => {
    const window = page();
    const malicious = sample("example.com", [2002]);
    malicious.captures[0].replayUrl = "https://attacker.example/phish";
    initSurprise(window.document as unknown as Document, async () => Response.json(malicious));
    (window.document.querySelector("#surprise-trigger") as unknown as HTMLButtonElement).click();
    await flush();
    expect(window.document.querySelector("#surprise-title")?.textContent).toBe("Not this time");
    expect(window.document.querySelectorAll(".surprise-snapshot")).toHaveLength(0);
    expect(window.document.querySelector("#surprise-status")?.textContent).toContain("could not be displayed");
  });
});
