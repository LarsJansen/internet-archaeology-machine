interface SurpriseCapture {
  year: number;
  timestamp: string;
  replayUrl: string;
  screenshotUrl: string;
}

interface SurpriseResponse {
  domain: string;
  captures: SurpriseCapture[];
  source: "r2-cached-screenshots";
  inventoryPartial: boolean;
  limitation: string;
}

function validSurprise(value: unknown): value is SurpriseResponse {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<SurpriseResponse>;
  if (
    typeof result.domain !== "string" ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(result.domain) ||
    result.source !== "r2-cached-screenshots" ||
    typeof result.limitation !== "string" ||
    typeof result.inventoryPartial !== "boolean" ||
    !Array.isArray(result.captures) ||
    result.captures.length < 1 || result.captures.length > 2
  ) return false;
  return result.captures.every((capture) => {
    if (
      !capture || typeof capture.year !== "number" ||
      !Number.isInteger(capture.year) ||
      typeof capture.timestamp !== "string" ||
      !/^\d{14}$/.test(capture.timestamp) ||
      capture.timestamp.slice(0, 4) !== String(capture.year) ||
      typeof capture.replayUrl !== "string" ||
      typeof capture.screenshotUrl !== "string"
    ) return false;
    try {
      const archive = new URL(capture.replayUrl);
      const image = new URL(capture.screenshotUrl, "https://iam.test");
      return archive.protocol === "https:" && archive.hostname === "web.archive.org" &&
        archive.pathname.startsWith(`/web/${capture.timestamp}/`) &&
        image.origin === "https://iam.test" &&
        image.pathname === "/api/screenshot" &&
        image.searchParams.get("domain") === result.domain &&
        image.searchParams.get("year") === String(capture.year) &&
        image.searchParams.get("timestamp") === capture.timestamp;
    } catch {
      return false;
    }
  });
}

function displayDate(timestamp: string): string {
  const yyyy = timestamp.slice(0, 4);
  const mm = timestamp.slice(4, 6);
  const dd = timestamp.slice(6, 8);
  const hh = timestamp.slice(8, 10);
  const min = timestamp.slice(10, 12);
  return `${yyyy}-${mm}-${dd} · ${hh}:${min} UTC`;
}

export function initSurprise(document: Document, fetchImpl: typeof fetch = fetch): void {
  const trigger = document.querySelector<HTMLButtonElement>("#surprise-trigger");
  const panel = document.querySelector<HTMLElement>("#surprise-result");
  const title = document.querySelector<HTMLElement>("#surprise-title");
  const status = document.querySelector<HTMLElement>("#surprise-status");
  const gallery = document.querySelector<HTMLElement>("#surprise-gallery");
  const caveat = document.querySelector<HTMLElement>("#surprise-caveat");
  const again = document.querySelector<HTMLButtonElement>("#surprise-again");
  const explore = document.querySelector<HTMLButtonElement>("#surprise-explore");
  const domainInput = document.querySelector<HTMLInputElement>("#domain");
  const form = document.querySelector<HTMLFormElement>("#search-form");
  const searchCard = document.querySelector<HTMLElement>(".search-card");

  if (!trigger || !panel || !title || !status || !gallery || !caveat || !again || !explore || !domainInput || !form) return;

  let pending = false;
  let lastDomain = "";
  let selectedDomain = "";

  const showDiscovery = (result: SurpriseResponse): void => {
    selectedDomain = result.domain;
    lastDomain = result.domain;
    title.textContent = result.domain;
    gallery.replaceChildren();

    for (const capture of result.captures) {
      const article = document.createElement("article");
      article.className = "surprise-snapshot card";

      const heading = document.createElement("h3");
      heading.className = "h4 mb-2";
      heading.textContent = `Archive year ${capture.year}`;

      const image = document.createElement("img");
      image.className = "surprise-image";
      image.src = capture.screenshotUrl;
      image.alt = `Saved Wayback screenshot requested for ${result.domain} in ${capture.year}; archived content may differ from the requested year`;
      image.loading = "lazy";
      image.decoding = "async";
      image.width = 1280;
      image.height = 900;

      const meta = document.createElement("p");
      meta.className = "text-secondary mb-2 surprise-meta";
      meta.textContent = `Indexed capture: ${displayDate(capture.timestamp)}`;

      const source = document.createElement("a");
      source.className = "surprise-source";
      source.href = capture.replayUrl;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = "View original Wayback replay";

      article.append(heading, image, meta, source);
      gallery.append(article);
    }

    status.textContent = result.captures.length === 2
      ? "Two saved snapshots from the same website. The internet really did look different."
      : "One saved snapshot from the archive. More years may be available to explore.";
    caveat.textContent = result.limitation +
      (result.inventoryPartial ? " This is a bounded sample of our saved collection, not a complete catalogue." : "");
    explore.hidden = false;
  };

  const discover = async (): Promise<void> => {
    if (pending) return;
    pending = true;
    selectedDomain = "";
    trigger.disabled = true;
    again.disabled = true;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    explore.hidden = true;
    title.textContent = "Searching the collection…";
    status.textContent = "Looking through screenshots already saved from the Wayback Machine.";
    caveat.textContent = "";
    gallery.replaceChildren();

    try {
      const url = lastDomain ? `/api/surprise?exclude=${encodeURIComponent(lastDomain)}` : "/api/surprise";
      const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const error = payload as { error?: { message?: unknown } } | null;
        throw new Error(typeof error?.error?.message === "string" ? error.error.message : "No discovery was available right now.");
      }
      if (!validSurprise(payload)) throw new Error("The saved discovery could not be displayed.");
      showDiscovery(payload);
    } catch (error) {
      title.textContent = "Not this time";
      status.textContent = error instanceof Error ? error.message : "We couldn't load a discovery. Try again.";
    } finally {
      pending = false;
      trigger.disabled = false;
      again.disabled = false;
    }
  };

  trigger.addEventListener("click", () => { void discover(); });
  again.addEventListener("click", () => { void discover(); });
  explore.addEventListener("click", () => {
    if (!selectedDomain) return;
    domainInput.value = selectedDomain;
    form.requestSubmit();
    searchCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  });
}
