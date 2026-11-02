export const PUBLIC_DAILY_LIMIT = 6;
export const VISITOR_DAILY_LIMIT = 2;
export const CAPTURE_COOLDOWN_SECONDS = 15;
export const LEASE_SECONDS = 90;

export type Admission =
  | { allowed: true; lease: string }
  | { allowed: false; code: "SITE_BUDGET_EXHAUSTED" | "VISITOR_BUDGET_EXHAUSTED" | "SCREENSHOT_BUSY" | "SCREENSHOT_COOLDOWN"; retryAfter: number };

interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}
type ActiveLease = { id: string; key: string; expires: number };
type DailyCounter = { day: string; count: number };

function utcDay(timestamp: number): string { return new Date(timestamp).toISOString().slice(0, 10); }
function secondsUntilTomorrow(timestamp: number): number {
  const midnight = Date.parse(utcDay(timestamp) + "T00:00:00.000Z") + 86_400_000;
  return Math.max(1, Math.ceil((midnight - timestamp) / 1000));
}

// Durable Objects are single instances, but RPC methods can interleave across
// awaits. Serialise reservations and releases over the same storage and queue.
export class ScreenshotQuota {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {}

  private async serial<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let done!: () => void;
    this.queue = new Promise<void>((resolve) => { done = resolve; });
    await prev;
    try { return await fn(); } finally { done(); }
  }

  reserve(key: string, visitor: string | null, owner: boolean): Promise<Admission> {
    return this.serial(async () => {
      const now = this.clock();
      const active = await this.store.get<ActiveLease>("active");
      if (active && active.expires > now) {
        return { allowed: false, code: "SCREENSHOT_BUSY", retryAfter: Math.ceil((active.expires - now) / 1000) };
      }
      const latest = (await this.store.get<number>("lastAttempt")) ?? 0;
      if (latest + CAPTURE_COOLDOWN_SECONDS * 1000 > now) {
        return { allowed: false, code: "SCREENSHOT_COOLDOWN", retryAfter: Math.ceil((latest + CAPTURE_COOLDOWN_SECONDS * 1000 - now) / 1000) };
      }

      if (!owner) {
        if (!visitor || !/^[a-f0-9]{64}$/.test(visitor)) {
          return { allowed: false, code: "VISITOR_BUDGET_EXHAUSTED", retryAfter: 3600 };
        }
        const day = utcDay(now);
        const site = (await this.store.get<DailyCounter>("daily")) ?? { day, count: 0 };
        if (site.day === day && site.count >= PUBLIC_DAILY_LIMIT) {
          return { allowed: false, code: "SITE_BUDGET_EXHAUSTED", retryAfter: secondsUntilTomorrow(now) };
        }
        const visitorKey = `visitor:${day}:${visitor}`;
        const used = (await this.store.get<number>(visitorKey)) ?? 0;
        if (used >= VISITOR_DAILY_LIMIT) {
          return { allowed: false, code: "VISITOR_BUDGET_EXHAUSTED", retryAfter: secondsUntilTomorrow(now) };
        }
        // Charge attempts, not just successful PNGs: failed browser actions
        // still consume quota and should never be retried indefinitely.
        await this.store.put("daily", { day, count: (site.day === day ? site.count : 0) + 1 });
        await this.store.put(visitorKey, used + 1);
      }

      const lease = crypto.randomUUID();
      await this.store.put("lastAttempt", now);
      await this.store.put("active", { id: lease, key, expires: now + LEASE_SECONDS * 1000 });
      return { allowed: true, lease };
    });
  }

  release(lease: string): Promise<void> {
    return this.serial(async () => {
      const active = await this.store.get<ActiveLease>("active");
      if (active?.id === lease) await this.store.delete("active");
    });
  }
}
