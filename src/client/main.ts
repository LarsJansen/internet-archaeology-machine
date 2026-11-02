import type { ApiErrorResponse, Capture, CapturesResponse, YearsResponse } from "../shared/capture-types";
import "./styles.css";
import { discoverySources, renderDiscoveryCard } from "./discovery-card";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCaptureTimestamp(timestamp: string): string {
  if (!/^\d{14}$/.test(timestamp)) {
    return timestamp;
  }

  const monthIndex = Number(timestamp.slice(4, 6)) - 1;
  if (monthIndex < 0 || monthIndex >= MONTHS.length) {
    return timestamp;
  }

  return `${timestamp.slice(6, 8)} ${MONTHS[monthIndex]} ${timestamp.slice(0, 4)} at ${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)} UTC`;
}

function isCapturesResponse(value: unknown): value is CapturesResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CapturesResponse>;
  return typeof candidate.domain === "string" && candidate.source === "internet-archive-cdx" && Array.isArray(candidate.captures);
}

function isYearsResponse(value: unknown): value is YearsResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<YearsResponse>;
  if (
    typeof candidate.domain !== "string" ||
    candidate.source !== "internet-archive-cdx" ||
    !Array.isArray(candidate.years) ||
    typeof candidate.truncated !== "boolean" ||
    typeof candidate.limitation !== "string"
  ) return false;
  const currentYear = new Date().getUTCFullYear();
  return candidate.years.every((year) =>
    typeof year === "number" && Number.isInteger(year) && year >= 1996 && year <= currentYear
  );
}

function errorMessage(value: unknown): string {
  if (!value || typeof value !== "object") return "The archive request failed.";
  const candidate = value as Partial<ApiErrorResponse>;
  return candidate.error && typeof candidate.error.message === "string"
    ? candidate.error.message
    : "The archive request failed.";
}

function createCaptureItem(
  document: Document,
  year: number,
  capture: Capture,
  onReplace: () => void,
  onScreenshot: () => void,
  screenshotReady: boolean,
  isCurator: boolean,
): HTMLLIElement {
  const item = document.createElement("li");
  const yearHeading = document.createElement("h4");
  const link = document.createElement("a");
  const metadata = document.createElement("span");
  const screenshotButton = document.createElement("button");
  const replaceButton = document.createElement("button");

  item.className = "capture-card";
  yearHeading.textContent = String(year);
  link.href = capture.replayUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = formatCaptureTimestamp(capture.timestamp);
  metadata.textContent = `${capture.statusCode} · ${capture.mimeType}`;
  screenshotButton.type = "button";
  screenshotButton.className = "btn btn-primary btn-sm screenshot-capture";
  screenshotButton.dataset.screenshotYear = String(year);
  screenshotButton.textContent = "Save missing screenshot";
  screenshotButton.disabled = screenshotReady;
  screenshotButton.addEventListener("click", onScreenshot);
  replaceButton.type = "button";
  replaceButton.className = "btn btn-outline-secondary btn-sm replace-capture";
  replaceButton.dataset.replaceYear = String(year);
  replaceButton.setAttribute("aria-label", `Replace ${year} in comparison`);
  replaceButton.textContent = "Replace this year";
  replaceButton.addEventListener("click", onReplace);

  const actions = document.createElement("div");
  actions.className = "capture-actions";
  if (isCurator && !screenshotReady) actions.append(screenshotButton);
  actions.append(replaceButton);
  item.append(yearHeading, link, metadata, actions);
  return item;
}

function setYearState(button: HTMLButtonElement, label: string, state: string): void {
  const stateElement = button.querySelector<HTMLElement>(".year-state");
  if (!stateElement) return;
  button.dataset.state = state;
  button.setAttribute("aria-label", `${button.dataset.year}: ${label}`);
  stateElement.textContent = label;
}

export function initSearch(document: Document, fetchImpl: typeof fetch = fetch): void {
  const form = document.querySelector<HTMLFormElement>("#search-form");
  const input = document.querySelector<HTMLInputElement>("#domain");
  const formButton = form?.querySelector<HTMLButtonElement>("button[type='submit']");
  const status = document.querySelector<HTMLElement>("#status");
  const results = document.querySelector<HTMLElement>("#results");
  const heading = document.querySelector<HTMLElement>("#results-heading");
  const timelineNote = document.querySelector<HTMLElement>(".timeline-note");
  const yearList = document.querySelector<HTMLOListElement>("#year-list");
  const selectedCapture = document.querySelector<HTMLElement>("#selected-capture");
  const captureHeading = document.querySelector<HTMLElement>("#capture-heading");
  const captureList = document.querySelector<HTMLUListElement>("#capture-list");
  const ownerTools = document.querySelector<HTMLElement>("#owner-tools");
  const ownerLoginForm = document.querySelector<HTMLFormElement>("#owner-login-form");
  const ownerLoginToken = document.querySelector<HTMLInputElement>("#owner-login-token");
  const ownerSignedIn = document.querySelector<HTMLElement>("#owner-signed-in");
  const ownerLogoutButton = document.querySelector<HTMLButtonElement>("#owner-logout-button");
  const ownerAuthStatus = document.querySelector<HTMLElement>("#owner-auth-status");
  const shareActions = document.querySelector<HTMLElement>("#share-card-actions");
  const downloadDiscovery = document.querySelector<HTMLButtonElement>("#download-discovery");
  const copyDiscoverySources = document.querySelector<HTMLButtonElement>("#copy-discovery-sources");
  const screenshotResult = document.querySelector<HTMLElement>("#screenshot-result");
  const screenshotCaption = document.querySelector<HTMLElement>("#screenshot-caption");
  const screenshotImage = document.querySelector<HTMLImageElement>("#screenshot-image");

  if (
    !form ||
    !input ||
    !formButton ||
    !status ||
    !results ||
    !heading ||
    !yearList ||
    !selectedCapture ||
    !captureHeading ||
    !captureList ||
    !screenshotResult ||
    !screenshotCaption ||
    !screenshotImage
  ) {
    throw new Error("Search interface markup is incomplete.");
  }

  let requestPending = false;
  let timelinePending = false;
  let screenshotPending = false;
  let isCurator = false;
  const screenshotObjectUrls = new Map<number, string>();
  const attemptedCacheLookups = new Set<number>();
  let activeDomain = "";
  let searchGeneration = 0;
  const checkedYears = new Map<number, Capture | null>();
  let comparedCaptures: Array<{ year: number; capture: Capture }> = [];

  const secondImage = document.querySelector<HTMLImageElement>("#screenshot-image-second");
  const secondCaption = document.querySelector<HTMLElement>("#screenshot-caption-second");
  const secondResult = document.querySelector<HTMLElement>("#screenshot-result-second");

  const updateCuratorUI = () => {
    if (ownerTools) ownerTools.hidden = !isCurator;
    if (ownerLoginForm) ownerLoginForm.hidden = isCurator;
    if (ownerSignedIn) ownerSignedIn.hidden = !isCurator;
    if (activeDomain) renderComparison(activeDomain);
  };

  const refreshCuratorSession = async () => {
    if (!ownerLoginForm) return;
    try {
      const response = await fetchImpl("/api/owner/session", { headers: { Accept: "application/json" }, credentials: "same-origin" });
      if (!response.ok) return;
      const result = (await response.json()) as { authenticated?: boolean };
      isCurator = result.authenticated === true;
      updateCuratorUI();
    } catch {
      // Public browsing works even if the curator session check fails.
    }
  };

  if (ownerLoginForm && ownerLoginToken) {
    ownerLoginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = ownerLoginToken.value;
      ownerLoginToken.value = "";
      if (!token) { if (ownerAuthStatus) ownerAuthStatus.textContent = "Enter the curator token."; return; }
      void (async () => {
        try {
          const response = await fetchImpl("/api/owner/login", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token }),
          });
          if (!response.ok) {
            const error: unknown = await response.json();
            if (ownerAuthStatus) ownerAuthStatus.textContent = errorMessage(error);
            return;
          }
          isCurator = true;
          if (ownerAuthStatus) ownerAuthStatus.textContent = "Signed in. Your session lasts seven days.";
          updateCuratorUI();
        } catch {
          if (ownerAuthStatus) ownerAuthStatus.textContent = "Could not sign in. Try again.";
        }
      })();
    });
  }
  ownerLogoutButton?.addEventListener("click", () => {
    void (async () => {
      try { await fetchImpl("/api/owner/logout", { method: "POST", credentials: "same-origin" }); } catch { /* Session expires automatically. */ }
      isCurator = false;
      if (ownerAuthStatus) ownerAuthStatus.textContent = "Signed out.";
      updateCuratorUI();
    })();
  });
  void refreshCuratorSession();

  const clearScreenshot = () => {
    for (const url of screenshotObjectUrls.values()) URL.revokeObjectURL(url);
    screenshotObjectUrls.clear();
    attemptedCacheLookups.clear();
    for (const [image, caption, section] of [
      [screenshotImage, screenshotCaption, screenshotResult],
      [secondImage, secondCaption, secondResult],
    ] as const) {
      image?.removeAttribute("src");
      if (image) image.alt = "";
      if (caption) caption.textContent = "";
      if (section) section.hidden = true;
    }
  };

  // URLs live only in this tab. The archive is never screenshot in bulk or on page load.
  const renderScreenshots = (domain: string) => {
    const gallery = document.querySelector<HTMLElement>("#comparison-gallery");
    if (gallery) gallery.hidden = comparedCaptures.length === 0;
    const slots = [
      {
        panel: document.querySelector<HTMLElement>("#image-panel-first"),
        yearLabel: document.querySelector<HTMLElement>("#visual-year-first"),
        placeholder: document.querySelector<HTMLElement>("#visual-placeholder-first"),
        image: screenshotImage,
        caption: screenshotCaption,
        result: screenshotResult,
      },
      {
        panel: document.querySelector<HTMLElement>("#image-panel-second"),
        yearLabel: document.querySelector<HTMLElement>("#visual-year-second"),
        placeholder: document.querySelector<HTMLElement>("#visual-placeholder-second"),
        image: secondImage,
        caption: secondCaption,
        result: secondResult,
      },
    ];
    slots.forEach((slot, index) => {
      const selected = comparedCaptures[index];
      if (slot.panel) slot.panel.hidden = !selected;
      if (!selected) {
        slot.image?.removeAttribute("src");
        if (slot.result) slot.result.hidden = true;
        if (slot.placeholder) slot.placeholder.hidden = false;
        return;
      }
      if (slot.yearLabel) slot.yearLabel.textContent = String(selected.year);
      const objectUrl = screenshotObjectUrls.get(selected.year);
      if (!objectUrl) {
        slot.image?.removeAttribute("src");
        if (slot.result) slot.result.hidden = true;
        if (slot.placeholder) slot.placeholder.hidden = false;
        return;
      }
      if (slot.image) {
        if (slot.image.src !== objectUrl) slot.image.src = objectUrl;
        slot.image.alt = `Wayback replay screenshot requested for ${domain} in ${selected.year}; the replay may redirect to a different archived date`;
      }
      if (slot.caption) slot.caption.textContent = `Replay requested for ${domain} in ${selected.year}. Wayback may redirect to another date.`;
      if (slot.result) slot.result.hidden = false;
      if (slot.placeholder) slot.placeholder.hidden = true;
    });
  };

  const exportEntries = () => {
    if (comparedCaptures.length !== 2 || !secondImage) return null;
    const images = [screenshotImage, secondImage];
    if (!comparedCaptures.every(({ year }, i) => screenshotObjectUrls.has(year) && images[i].complete && images[i].naturalWidth > 0)) return null;
    return comparedCaptures.map((compared, i) => ({ ...compared, image: images[i] }));
  };

  // PNG export only activates after both saved images have actually decoded.
  const refreshExportAvailability = () => {
    if (downloadDiscovery) downloadDiscovery.disabled = exportEntries() === null;
  };
  screenshotImage.addEventListener("load", refreshExportAvailability);
  secondImage?.addEventListener("load", refreshExportAvailability);
  screenshotImage.addEventListener("error", refreshExportAvailability);
  secondImage?.addEventListener("error", refreshExportAvailability);

  downloadDiscovery?.addEventListener("click", () => {
    const entries = exportEntries();
    if (!entries) { status.textContent = "Both saved screenshots need to load before you can download a comparison."; return; }
    try {
      const canvas = document.createElement("canvas");
      renderDiscoveryCard(canvas, activeDomain, entries);
      if (!canvas.toBlob) throw new Error("PNG export is not supported by this browser.");
      downloadDiscovery.disabled = true;
      canvas.toBlob((blob) => {
        downloadDiscovery.disabled = false;
        if (!blob) { status.textContent = "This browser could not create the comparison PNG."; return; }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `internet-archaeology-${activeDomain}-${entries[0].year}-vs-${entries[1].year}.png`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = "Comparison downloaded. Copy the archive sources when you share it.";
      }, "image/png");
    } catch (error) {
      downloadDiscovery.disabled = false;
      status.textContent = error instanceof Error ? error.message : "Could not create the comparison card.";
    }
  });

  copyDiscoverySources?.addEventListener("click", () => {
    if (comparedCaptures.length !== 2) return;
    const entries = comparedCaptures.map((capture) => ({
      ...capture,
      image: screenshotImage,
    }));
    const sources = discoverySources(activeDomain, entries);
    const clipboard = document.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(sources).then(
        () => { status.textContent = "Both archive source links copied. Paste them alongside the image."; },
        () => { status.textContent = "Your browser blocked copying. You can open the archive links above."; },
      );
    } else {
      status.textContent = "Your browser does not support clipboard copying here. Use the archive links above.";
    }
  });

  // Public cache reads are safe: no owner secret and no Browser Run request.
  // The archive capture timestamp prevents different replays in the same year colliding.
  const loadCachedScreenshot = async (year: number, capture: Capture, domain: string) => {
    if (attemptedCacheLookups.has(year) || screenshotObjectUrls.has(year)) return;
    attemptedCacheLookups.add(year);
    const generation = searchGeneration;
    const url = `/api/screenshot?domain=${encodeURIComponent(domain)}&year=${year}&timestamp=${encodeURIComponent(capture.timestamp)}`;
    try {
      const response = await fetchImpl(url, { headers: { Accept: "image/png, application/json" } });
      if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/png")) return;
      const objectUrl = URL.createObjectURL(await response.blob());
      if (generation !== searchGeneration || screenshotObjectUrls.has(year)) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      screenshotObjectUrls.set(year, objectUrl);
      renderComparison(domain);
    } catch {
      // A screenshot cache miss/failure never prevents browsing verified capture metadata.
    }
  };

  const takeScreenshot = async (year: number, domain: string) => {
    if (requestPending || screenshotPending || screenshotObjectUrls.has(year)) return;
    if (!isCurator) {
      status.textContent = "Only the curator can save a new screenshot.";
      return;
    }

    screenshotPending = true;
    const requestedGeneration = searchGeneration;
    const interactiveButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "#year-list button, #capture-list .replace-capture, #capture-list .screenshot-capture",
      ),
    );
    interactiveButtons.forEach((button) => (button.disabled = true));
    formButton.disabled = true;
    status.textContent = `Capturing the ${year} Wayback replay…`;

    try {
      const response = await fetchImpl("/api/screenshot", {
        method: "POST",
        headers: {
          Accept: "image/png, application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domain, year }),
        credentials: "same-origin",
      });
      if (!response.ok) {
        const payload: unknown = await response.json();
        status.textContent = errorMessage(payload);
        return;
      }
      if (!response.headers.get("Content-Type")?.startsWith("image/")) {
        status.textContent = "The screenshot service returned an unexpected response.";
        return;
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      if (requestedGeneration !== searchGeneration) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      screenshotObjectUrls.set(year, objectUrl);
      renderComparison(domain);
      status.textContent = response.headers.get("X-IAM-Screenshot-Source") === "cached"
        ? `Loaded a saved screenshot for ${domain} in ${year}.`
        : `Screenshot saved for everyone to view: ${domain} in ${year}.`;
    } catch {
      status.textContent = "The screenshot service could not be reached. Try again later.";
    } finally {
      screenshotPending = false;
      interactiveButtons.forEach((button) => (button.disabled = false));
      formButton.disabled = false;
    }
  };

  const renderComparison = (domain: string) => {
    captureList.replaceChildren();
    for (const compared of comparedCaptures) {
      captureList.append(
        createCaptureItem(
          document,
          compared.year,
          compared.capture,
          () => {
            comparedCaptures = comparedCaptures.filter(({ year }) => year !== compared.year);
            renderComparison(domain);
            status.textContent = `Choose another year to replace ${compared.year}.`;
            yearList.querySelector<HTMLButtonElement>(`button[data-year="${compared.year}"]`)?.focus();
          },
          () => void takeScreenshot(compared.year, domain),
          screenshotObjectUrls.has(compared.year),
          isCurator,
        ),
      );
    }
    captureHeading.textContent = `Verified captures for ${domain}`;
    selectedCapture.hidden = comparedCaptures.length === 0;
    renderScreenshots(domain);
    if (shareActions) shareActions.hidden = comparedCaptures.length !== 2;
    if (downloadDiscovery) downloadDiscovery.disabled = exportEntries() === null;
  };

  const addToComparison = (year: number, capture: Capture, domain: string) => {
    if (comparedCaptures.some((compared) => compared.year === year)) {
      status.textContent = `${year} is already in the comparison.`;
      return;
    }
    if (comparedCaptures.length >= 2) {
      status.textContent = "The comparison already has two captures. Replace either year before adding another.";
      return;
    }
    comparedCaptures.push({ year, capture });
    renderComparison(domain);
    status.textContent = `Capture found for ${domain} in ${year}.`;
    void loadCachedScreenshot(year, capture, domain);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (requestPending || screenshotPending || timelinePending) return;

    const domain = input.value.trim();
    const generation = ++searchGeneration;
    if (domain !== activeDomain) {
      checkedYears.clear();
      comparedCaptures = [];
      activeDomain = domain;
      clearScreenshot();
    }
    yearList.replaceChildren();
    renderComparison(domain);
    results.hidden = true;

    const checkYear = async (year: number, yearButton: HTMLButtonElement) => {
      if (requestPending || screenshotPending || timelinePending) return;
      if (checkedYears.has(year)) {
        const cachedCapture = checkedYears.get(year);
        if (cachedCapture) {
          setYearState(yearButton, "Capture found", "found");
          addToComparison(year, cachedCapture, domain);
        } else {
          setYearState(yearButton, "No capture returned", "empty");
          status.textContent = `No indexed homepage capture was returned for ${domain} in ${year}.`;
        }
        return;
      }
      requestPending = true;
      const allYearButtons = Array.from(yearList.querySelectorAll<HTMLButtonElement>("button"));
      const replaceButtons = Array.from(captureList.querySelectorAll<HTMLButtonElement>(".replace-capture"));
      allYearButtons.forEach((button) => (button.disabled = true));
      replaceButtons.forEach((button) => (button.disabled = true));
      formButton.disabled = true;
      setYearState(yearButton, "Checking…", "checking");
      status.textContent = `Checking ${domain} in ${year}…`;

      try {
        const response = await fetchImpl(
          `/api/captures?domain=${encodeURIComponent(domain)}&year=${encodeURIComponent(String(year))}`,
          { headers: { Accept: "application/json" } },
        );
        const payload: unknown = await response.json();

        if (!response.ok) {
          setYearState(yearButton, "Check failed", "error");
          status.textContent = errorMessage(payload);
          return;
        }
        if (!isCapturesResponse(payload)) {
          setYearState(yearButton, "Check failed", "error");
          status.textContent = "The archive returned an unexpected response.";
          return;
        }
        if (payload.captures.length === 0) {
          checkedYears.set(year, null);
          setYearState(yearButton, "No capture returned", "empty");
          status.textContent = `No indexed homepage capture was returned for ${payload.domain} in ${year}.`;
          return;
        }

        const capture = payload.captures[0];
        checkedYears.set(year, capture);
        setYearState(yearButton, "Capture found", "found");
        addToComparison(year, capture, payload.domain);
      } catch {
        setYearState(yearButton, "Check failed", "error");
        status.textContent = "The archive could not be reached. Try again later.";
      } finally {
        requestPending = false;
        allYearButtons.forEach((button) => (button.disabled = false));
        replaceButtons.forEach((button) => (button.disabled = false));
        formButton.disabled = false;
      }
    };

    timelinePending = true;
    formButton.disabled = true;
    status.textContent = `Finding indexed homepage years for ${domain}…`;
    void (async () => {
      try {
        const response = await fetchImpl(
          `/api/years?domain=${encodeURIComponent(domain)}`,
          { headers: { Accept: "application/json" } },
        );
        const payload: unknown = await response.json();
        if (generation !== searchGeneration) return;
        if (!response.ok) {
          status.textContent = errorMessage(payload);
          return;
        }
        if (!isYearsResponse(payload)) {
          status.textContent = "The archive year index returned an unexpected response.";
          return;
        }

        const years = [...new Set(payload.years)].sort((a, b) => a - b);
        for (const year of years) {
          const item = document.createElement("li");
          const yearButton = document.createElement("button");
          const yearLabel = document.createElement("span");
          const yearState = document.createElement("span");

          yearButton.type = "button";
          yearButton.dataset.year = String(year);
          yearButton.dataset.state = "indexed";
          yearButton.setAttribute("aria-label", `${year}: Indexed capture found, click to verify`);
          yearLabel.className = "year-label";
          yearLabel.textContent = String(year);
          yearState.className = "year-state";
          yearState.textContent = "In archive index";
          yearButton.append(yearLabel, yearState);
          yearButton.addEventListener("click", () => void checkYear(year, yearButton));
          item.append(yearButton);
          yearList.append(item);
          if (checkedYears.has(year)) {
            const cachedCapture = checkedYears.get(year);
            setYearState(
              yearButton,
              cachedCapture ? "Capture found" : "No capture returned",
              cachedCapture ? "found" : "empty",
            );
          }
        }
        heading.textContent = `Indexed years for ${payload.domain}`;
        if (timelineNote) timelineNote.textContent = payload.limitation;
        status.textContent = years.length
          ? `Found ${years.length} indexed ${years.length === 1 ? "year" : "years"} for ${payload.domain}. Select a year to verify its capture.`
          : `No matching homepage captures were found in the archive index for ${payload.domain}. This does not prove the site was offline.`;
        results.hidden = false;
      } catch {
        if (generation === searchGeneration) status.textContent = "The archive year index could not be reached. Try again later.";
      } finally {
        timelinePending = false;
        formButton.disabled = false;
      }
    })();
  });
}

if (typeof document !== "undefined") {
  initSearch(document);
}
