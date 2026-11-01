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

function createCaptureItem(document: Document, capture: Capture): HTMLLIElement {
  const item = document.createElement("li");
  const link = document.createElement("a");
  const metadata = document.createElement("span");

  link.href = capture.replayUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = formatCaptureTimestamp(capture.timestamp);
  metadata.textContent = `${capture.statusCode} · ${capture.mimeType}`;

  item.append(link, metadata);
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
    !captureList
  ) {
    throw new Error("Search interface markup is incomplete.");
  }

  let requestPending = false;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (requestPending) return;

    const domain = input.value.trim();
    const currentYear = new Date().getUTCFullYear();
    yearList.replaceChildren();
    captureList.replaceChildren();
    selectedCapture.hidden = true;

    const checkYear = async (year: number, yearButton: HTMLButtonElement) => {
      if (requestPending) return;
      requestPending = true;
      const allYearButtons = Array.from(yearList.querySelectorAll<HTMLButtonElement>("button"));
      allYearButtons.forEach((button) => (button.disabled = true));
      formButton.disabled = true;
      setYearState(yearButton, "Checking…", "checking");
      status.textContent = `Checking ${domain} in ${year}…`;
      captureList.replaceChildren();
      selectedCapture.hidden = true;

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
          setYearState(yearButton, "No capture returned", "empty");
          status.textContent = `No indexed homepage capture was returned for ${payload.domain} in ${year}.`;
          return;
        }

        const capture = payload.captures[0];
        captureList.append(createCaptureItem(document, capture));
        captureHeading.textContent = `${year} capture for ${payload.domain}`;
        selectedCapture.hidden = false;
        setYearState(yearButton, "Capture found", "found");
        status.textContent = `Capture found for ${payload.domain} in ${year}.`;
      } catch {
        setYearState(yearButton, "Check failed", "error");
        status.textContent = "The archive could not be reached. Try again later.";
      } finally {
        requestPending = false;
        allYearButtons.forEach((button) => (button.disabled = false));
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
    }

    heading.textContent = `Years to check for ${domain}`;
    status.textContent = `Choose one year to check for ${domain}.`;
    results.hidden = false;
  });
}

if (typeof document !== "undefined") {
  initSearch(document);
}
