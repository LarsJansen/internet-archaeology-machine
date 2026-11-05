import {
  parseDiscoveryPath,
  isSavedDiscoveryResponse,
} from "../shared/discovery-link";

export function initSharedDiscovery(document: Document, fetchImpl: typeof fetch = fetch): void {
  const route = parseDiscoveryPath(document.location?.pathname ?? "/");
  if (!route) return;

  const panel = document.querySelector<HTMLElement>("#shared-discovery");
  const title = document.querySelector<HTMLElement>("#shared-discovery-title");
  const status = document.querySelector<HTMLElement>("#shared-discovery-status");
  const gallery = document.querySelector<HTMLElement>("#shared-discovery-gallery");
  const notice = document.querySelector<HTMLElement>("#shared-discovery-notice");
  const explore = document.querySelector<HTMLButtonElement>("#shared-discovery-explore");
  const copy = document.querySelector<HTMLButtonElement>("#shared-discovery-copy");
  const input = document.querySelector<HTMLInputElement>("#domain");
  const form = document.querySelector<HTMLFormElement>("#search-form");
  const searchCard = document.querySelector<HTMLElement>(".search-card");
  if (!panel || !title || !status || !gallery || !notice || !explore || !copy || !input || !form) return;

  panel.hidden = false;
  title.textContent = `${route.domain}: a saved internet discovery`;
  status.textContent = "Loading these exact archived snapshots from our saved collection…";
  explore.hidden = true;
  copy.hidden = true;

  const params = new URLSearchParams({ domain: route.domain });
  for (const timestamp of route.timestamps) params.append("timestamp", timestamp);

  void (async () => {
    try {
      const response = await fetchImpl(`/api/discovery?${params.toString()}`, {
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isSavedDiscoveryResponse(payload, route)) {
        title.textContent = "This saved discovery isn't available";
        status.textContent = "The original saved screenshots could not be found. You can still look for the website in the archive.";
        explore.hidden = false;
        return;
      }

      const years = payload.captures.map((capture) => capture.year);
      title.textContent = years.length === 2
        ? `${route.domain} — ${years[0]} vs ${years[1]}`
        : `${route.domain} — ${years[0]}`;
      status.textContent = years.length === 2
        ? "Two real saved Wayback screenshots from the same website."
        : "One real saved Wayback screenshot from the archive.";
      notice.textContent = payload.limitation;

      gallery.replaceChildren();
      for (const capture of payload.captures) {
        const article = document.createElement("article");
        article.className = "card shared-snapshot";
        const heading = document.createElement("h3");
        heading.className = "h4";
        heading.textContent = String(capture.year);
        const date = document.createElement("p");
        date.className = "text-secondary small mb-2";
        date.textContent = `Indexed capture: ${capture.timestamp.slice(0, 4)}-${capture.timestamp.slice(4, 6)}-${capture.timestamp.slice(6, 8)} ${capture.timestamp.slice(8, 10)}:${capture.timestamp.slice(10, 12)} UTC`;
        const image = document.createElement("img");
        image.src = capture.screenshotUrl;
        image.alt = `Saved Wayback replay requested for ${route.domain} in ${capture.year}; final rendered content may differ`;
        image.width = 1280;
        image.height = 900;
        image.loading = "lazy";
        image.decoding = "async";
        image.className = "shared-snapshot-image";
        const source = document.createElement("a");
        source.href = capture.replayUrl;
        source.textContent = "Open original Wayback capture";
        source.target = "_blank";
        source.rel = "noopener noreferrer";
        article.append(heading, date, image, source);
        gallery.append(article);
      }
      explore.hidden = false;
      copy.hidden = false;
      panel.scrollIntoView?.({ block: "nearest" });
    } catch {
      title.textContent = "We couldn't load this discovery";
      status.textContent = "Saved screenshots are temporarily unavailable. Try again or explore the archive.";
      explore.hidden = false;
    }
  })();

  explore.addEventListener("click", () => {
    input.value = route.domain;
    form.requestSubmit();
    searchCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  });

  copy.addEventListener("click", () => {
    const url = document.location?.href ?? "";
    const clipboard = document.defaultView?.navigator.clipboard;
    if (!url || !clipboard?.writeText) {
      status.textContent = "Copy the address from your browser's address bar to share this discovery.";
      return;
    }
    void clipboard.writeText(url).then(
      () => { status.textContent = "Discovery link copied. Share it anywhere."; },
      () => { status.textContent = "Copy the address from your browser's address bar to share this discovery."; },
    );
  });
}
