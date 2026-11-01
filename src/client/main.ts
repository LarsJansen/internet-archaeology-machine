import type { ApiErrorResponse, Capture, CapturesResponse } from "../shared/capture-types";
import "./styles.css";

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

export function initSearch(document: Document, fetchImpl: typeof fetch = fetch): void {
  const form = document.querySelector<HTMLFormElement>("#search-form");
  const input = document.querySelector<HTMLInputElement>("#domain");
  const button = form?.querySelector<HTMLButtonElement>("button[type='submit']");
  const status = document.querySelector<HTMLElement>("#status");
  const results = document.querySelector<HTMLElement>("#results");
  const heading = document.querySelector<HTMLElement>("#results-heading");
  const list = document.querySelector<HTMLUListElement>("#capture-list");

  if (!form || !input || !button || !status || !results || !heading || !list) {
    throw new Error("Search interface markup is incomplete.");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Searching the archive index…";
    results.hidden = true;
    list.replaceChildren();

    try {
      const response = await fetchImpl(`/api/captures?domain=${encodeURIComponent(input.value)}`, {
        headers: { Accept: "application/json" },
      });
      const payload: unknown = await response.json();

      if (!response.ok) {
        status.textContent = errorMessage(payload);
        return;
      }
      if (!isCapturesResponse(payload)) {
        status.textContent = "The archive returned an unexpected response.";
        return;
      }
      if (payload.captures.length === 0) {
        status.textContent = `No indexed homepage captures were returned for ${payload.domain}.`;
        return;
      }

      for (const capture of payload.captures) {
        list.append(createCaptureItem(document, capture));
      }
      const noun = payload.captures.length === 1 ? "capture" : "captures";
      status.textContent = `${payload.captures.length} ${noun} found for ${payload.domain}.`;
      heading.textContent = `Capture sample for ${payload.domain}`;
      results.hidden = false;
    } catch {
      status.textContent = "The archive could not be reached. Try again later.";
    } finally {
      button.disabled = false;
    }
  });
}

if (typeof document !== "undefined") {
  initSearch(document);
}
