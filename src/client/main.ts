import type { ApiErrorResponse, Capture, CapturesResponse } from "../shared/capture-types";
import "./styles.css";

const FIRST_ARCHIVE_YEAR = 1996;
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
  screenshotButton.textContent = screenshotReady ? "Screenshot captured" : "Screenshot this capture";
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
  actions.append(screenshotButton, replaceButton);
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
  const yearList = document.querySelector<HTMLOListElement>("#year-list");
  const selectedCapture = document.querySelector<HTMLElement>("#selected-capture");
  const captureHeading = document.querySelector<HTMLElement>("#capture-heading");
  const captureList = document.querySelector<HTMLUListElement>("#capture-list");
  const screenshotToken = document.querySelector<HTMLInputElement>("#screenshot-token");
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
    !screenshotToken ||
    !screenshotResult ||
    !screenshotCaption ||
    !screenshotImage
  ) {
    throw new Error("Search interface markup is incomplete.");
  }

  let requestPending = false;
  let screenshotPending = false;
  const screenshotObjectUrls = new Map<number, string>();
  let activeDomain = "";
  let searchGeneration = 0;
  const checkedYears = new Map<number, Capture | null>();
  let comparedCaptures: Array<{ year: number; capture: Capture }> = [];

  const secondImage = document.querySelector<HTMLImageElement>("#screenshot-image-second");
  const secondCaption = document.querySelector<HTMLElement>("#screenshot-caption-second");
  const secondResult = document.querySelector<HTMLElement>("#screenshot-result-second");

  const clearScreenshot = () => {
    for (const url of screenshotObjectUrls.values()) URL.revokeObjectURL(url);
    screenshotObjectUrls.clear();
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
        slot.image.src = objectUrl;
        slot.image.alt = `Wayback replay screenshot requested for ${domain} in ${selected.year}; the replay may redirect to a different archived date`;
      }
      if (slot.caption) slot.caption.textContent = `Replay requested for ${domain} in ${selected.year}. Wayback may redirect to another date.`;
      if (slot.result) slot.result.hidden = false;
      if (slot.placeholder) slot.placeholder.hidden = true;
    });
  };

  const takeScreenshot = async (year: number, domain: string) => {
    if (requestPending || screenshotPending || screenshotObjectUrls.has(year)) return;
    const token = screenshotToken.value;
    if (!token) {
      status.textContent = "Enter the owner screenshot token before requesting an image.";
      screenshotToken.focus();
      return;
    }

    screenshotPending = true;
    const requestedGeneration = searchGeneration;
    screenshotToken.value = "";
    const interactiveButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        "#year-list button, #capture-list .replace-capture, #capture-list .screenshot-capture",
      ),
    );
    interactiveButtons.forEach((button) => (button.disabled = true));
    formButton.disabled = true;
    screenshotToken.disabled = true;
    status.textContent = `Capturing the ${year} Wayback replay…`;

    try {
      const response = await fetchImpl("/api/screenshot", {
        method: "POST",
        headers: {
          Accept: "image/png, application/json",
          "Content-Type": "application/json",
          "X-Screenshot-Token": token,
        },
        body: JSON.stringify({ domain, year }),
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
      status.textContent = `Screenshot captured for ${domain} in ${year}.`;
    } catch {
      status.textContent = "The screenshot service could not be reached. Try again later.";
    } finally {
      screenshotPending = false;
      interactiveButtons.forEach((button) => (button.disabled = false));
      formButton.disabled = false;
      screenshotToken.disabled = false;
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
        ),
      );
    }
    captureHeading.textContent = `Verified captures for ${domain}`;
    selectedCapture.hidden = comparedCaptures.length === 0;
    renderScreenshots(domain);
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
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (requestPending || screenshotPending) return;

    const domain = input.value.trim();
    const currentYear = new Date().getUTCFullYear();
    if (domain !== activeDomain) {
      searchGeneration += 1;
      checkedYears.clear();
      comparedCaptures = [];
      activeDomain = domain;
      clearScreenshot();
    }
    yearList.replaceChildren();
    renderComparison(domain);

    const checkYear = async (year: number, yearButton: HTMLButtonElement) => {
      if (requestPending || screenshotPending) return;
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

    for (let year = FIRST_ARCHIVE_YEAR; year <= currentYear; year += 1) {
      const item = document.createElement("li");
      const yearButton = document.createElement("button");
      const yearLabel = document.createElement("span");
      const yearState = document.createElement("span");

      yearButton.type = "button";
      yearButton.dataset.year = String(year);
      yearButton.dataset.state = "unchecked";
      yearButton.setAttribute("aria-label", `${year}: Not checked`);
      yearLabel.className = "year-label";
      yearLabel.textContent = String(year);
      yearState.className = "year-state";
      yearState.textContent = "Not checked";
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

    heading.textContent = `Years to check for ${domain}`;
    status.textContent = `Choose one year to check for ${domain}.`;
    results.hidden = false;
  });
}

if (typeof document !== "undefined") {
  initSearch(document);
}
