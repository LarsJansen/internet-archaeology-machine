import { describe, expect, it, vi } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, discoverySources, renderDiscoveryCard } from "../src/client/discovery-card";
import type { Capture } from "../src/shared/capture-types";

const capture = (year: number): Capture => ({
  timestamp: `${year}0120142510`,
  originalUrl: "http://example.com/",
  replayUrl: `https://web.archive.org/web/${year}0120142510/http://example.com/`,
  statusCode: "200",
  mimeType: "text/html",
  digest: "DIGEST",
  length: 1024,
});

const image = () => ({ complete: true, naturalWidth: 1280, naturalHeight: 900 }) as HTMLImageElement;

describe("shareable discovery cards", () => {
  it("includes both actual archive source URLs and distinguishes replays from original history", () => {
    const links = discoverySources("example.com", [
      { year: 2002, capture: capture(2002), image: image() },
      { year: 2020, capture: capture(2020), image: image() },
    ]);
    expect(links).toContain("2002-01-20 14:25 UTC");
    expect(links).toContain("2020-01-20 14:25 UTC");
    expect(links).toContain("https://web.archive.org/web/20020120142510/http://example.com/");
    expect(links).toContain("https://web.archive.org/web/20200120142510/http://example.com/");
    expect(links).toContain("modern renderings");
  });

  it("creates a labelled, fixed-size side-by-side PNG surface using two existing images", () => {
    const fillText = vi.fn();
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillRect: vi.fn(), strokeRect: vi.fn(),
        fillText, drawImage,
        measureText: (text: string) => ({ width: text.length * 10 }),
      }),
    } as unknown as HTMLCanvasElement;
    renderDiscoveryCard(canvas, "example.com", [
      { year: 2002, capture: capture(2002), image: image() },
      { year: 2020, capture: capture(2020), image: image() },
    ]);
    expect(canvas.width).toBe(CARD_WIDTH);
    expect(canvas.height).toBe(CARD_HEIGHT);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(fillText.mock.calls.map((args) => args[0])).toContain("example.com");
    expect(fillText.mock.calls.map((args) => args[0])).toContain("2020");
  });

  it("will not invent a comparison card when a screenshot is missing", () => {
    const canvas = { getContext: () => ({}) } as unknown as HTMLCanvasElement;
    expect(() => renderDiscoveryCard(canvas, "example.com", [{ year: 2002, capture: capture(2002), image: image() }])).toThrow("two archived screenshots");
    const missing = { complete: true, naturalWidth: 0, naturalHeight: 0 } as HTMLImageElement;
    expect(() => renderDiscoveryCard(canvas, "example.com", [
      { year: 2002, capture: capture(2002), image: image() },
      { year: 2020, capture: capture(2020), image: missing },
    ])).toThrow("finish loading");
  });
});
