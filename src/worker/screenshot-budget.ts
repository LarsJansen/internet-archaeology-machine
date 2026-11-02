import { DurableObject } from "cloudflare:workers";
import { ScreenshotQuota } from "./screenshot-budget-core";
import type { Admission } from "./screenshot-budget-core";

// A single coordinator is used only for expensive screenshot generation.
// All ordinary site browsing and cached image reads bypass it.
export class ScreenshotBudget extends DurableObject {
  private readonly quota = new ScreenshotQuota(this.ctx.storage);

  reserve(key: string, visitor: string | null, owner: boolean): Promise<Admission> {
    return this.quota.reserve(key, visitor, owner);
  }

  release(lease: string): Promise<void> {
    return this.quota.release(lease);
  }
}
