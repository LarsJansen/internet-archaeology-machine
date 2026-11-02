import { DurableObject } from "cloudflare:workers";

export const PUBLIC_DAILY_LIMIT = 6;
export const VISITOR_DAILY_LIMIT = 2;
export const CAPTURE_COOLDOWN_SECONDS = 15;
export const LEASE_SECONDS = 90;

type Denial = "SITE_BUDGET_EXHAUSTED" | "VISITOR_BUDGET_EXHAUSTED" | "SCREENSHOT_BUSY" | "SCREENSHOT_COOLDOWN";
export type Admission =
  | { allowed: true; lease: string }
  | { allowed: false; code: Denial; retryAfter: number };

type ActiveLease = { id: string; key: string; expires: number };
type DailyCounter = { day: string; count: number };

function today(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
function midnightRetry(timestamp: number): number {
  return Math.max(1, Math.ceil((Date.parse(today(timestamp) + "T00:00:00.000Z") + 86_400_000 - timestamp) / 1000));
}

// A single, globally named Durable Object is deliberately used ONLY for expensive
// screenshot admissions. Archive discovery and cached image reads never touch it.
// All admission checks and updates are serialized; a stored lease survives restarts.
export class ScreenshotBudget extends DurableObject {
  private queue: Promise<void> = Promise.resolve();

  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.queue;
    let unblock!: () => void;
    this.queue = new Promise<void>((resolve) => { unblock = resolve; });
    await before;
    try { return await fn(); }
    finally { unblock(); }
  }

  async reserve(key: string, visitor: string | null, owner: boolean): Promise<Admission> {
    return this.serial(async () => {
      const now = Date.now();
      const active = await this.ctx.storage.get<ActiveLease>("active");
      if (active && active.expires > now) {
        return { allowed: false, code: "SCREENSHOT_BUSY", retryAfter: Math.max(1, Math.ceil((active.expires - now) / 1000)) };
      }
      const latest = (await this.ctx.storage.get<number>("lastAttempt")) ?? 0;
      if (latest + CAPTURE_COOLDOWN_SECONDS * 1000 > now) {
        return { allowed: false, code: "SCREENSHOT_COOLDOWN", retryAfter: Math.max(1, Math.ceil((latest + CAPTURE_COOLDOWN_SECONDS * 1000 - now) / 1000)) };
      }

      if (!owner) {
        // A hashed, trusted Cloudflare IP is mandatory. Never group anonymous
        // "unknown" callers together or accept user-submitted identity strings.
        if (!visitor || !/^[a-f0-9]{64}$/.test(visitor)) {
          return { allowed: false, code: "VISITOR_BUDGET_EXHAUSTED", retryAfter: 3600 };
        }
        const day = today(now);
        const site = (await this.ctx.storage.get<DailyCounter>("daily")) ?? { day, count: 0 };
        if (site.day === day && site.count >= PUBLIC_DAILY_LIMIT) {
          return { allowed: false, code: "SITE_BUDGET_EXHAUSTED", retryAfter: midnightRetry(now) };
        }
        const visitorKey = `visitor:${day}:${visitor}`;
        const count = (await this.ctx.storage.get<number>(visitorKey)) ?? 0;
        if (count >= VISITOR_DAILY_LIMIT) {
          return { allowed: false, code: "VISITOR_BUDGET_EXHAUSTED", retryAfter: midnightRetry(now) };
        }
        // Count attempted Browser Run work, not only successes. Even failed
        // renders can consume browser minutes and should not retry endlessly.
        await this.ctx.storage.put("daily", { day, count: (site.day === day ? site.count : 0) + 1 });
        await this.ctx.storage.put(visitorKey, count + 1);
      }

      const lease = crypto.randomUUID();
      await this.ctx.storage.put("lastAttempt", now);
      await this.ctx.storage.put("active", { id: lease, key, expires: now + LEASE_SECONDS * 1000 });
      return { allowed: true, lease };
    });
  }

  async release(lease: string): Promise<void> {
    await this.serial(async () => {
      const active = await this.ctx.storage.get<ActiveLease>("active");
      if (active?.id === lease) await this.ctx.storage.delete("active");
    });
  }
}
