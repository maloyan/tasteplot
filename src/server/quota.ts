// Quota protection for the public demo. The hackathon Qloo key allows 5 requests
// per second and 10,000 per month. A public URL must never burn the month.
//
// Three guards, all on Workers Free primitives (KV only, no Durable Object):
// 1. A daily cap on FRESH Qloo calls (cache hits are free). Default 250 a day:
//    250 x 31 = 7,750, so the month stays under 10,000 with room for races and tests.
// 2. Qloo's own x-month-ratelimit-remaining header. Below MONTH_RESERVE, no fresh plan starts.
// 3. A per-IP limit on new plans (default 10 an hour). Cached and sample plans do not count.
//
// KV is eventually consistent and has no atomic increment, so two plans that start
// in the same second can both pass the check. The cap leaves room for that: one plan
// is at most MAX_QLOO_CALLS calls, and each plan's budget is clipped to what is left.
// The counter is written once per fresh plan, not once per call, to stay inside the
// Workers Free limit of 1,000 KV writes a day.
import type { KeyValueStore } from "../qloo/transport";
import type { QuotaInfo } from "../shared/types";

export const DEFAULT_DAILY_CAP = 250;
export const DEFAULT_PLANS_PER_HOUR = 10;
/** Stop fresh plans when Qloo says fewer than this many calls are left in the month. */
export const MONTH_RESERVE = 300;
/** A fresh plan starts only if at least this many calls are left today (a full plan uses 20 to 25). */
export const MIN_CALLS_FOR_PLAN = 25;

const day = (now: Date) => now.toISOString().slice(0, 10);
const hour = (now: Date) => now.toISOString().slice(0, 13);

interface Stored {
  used: number;
  monthRemaining?: number;
  /** True when the KV read failed. The quota then counts as used up (fail closed). */
  unreadable?: boolean;
}

export class Quota {
  constructor(
    private store: KeyValueStore,
    readonly cap: number = DEFAULT_DAILY_CAP,
    private now: () => Date = () => new Date(),
  ) {}

  private key() {
    return `quota:v1:${day(this.now())}`;
  }

  private async load(): Promise<Stored> {
    let raw: string | null;
    try {
      raw = await this.store.get(this.key());
    } catch (e) {
      console.warn(`quota read failed, fresh plans paused: ${(e as Error).message}`);
      return { used: this.cap, unreadable: true };
    }
    if (!raw) return { used: 0 };
    try {
      const v = JSON.parse(raw) as Stored;
      return { used: Number(v.used) || 0, monthRemaining: v.monthRemaining };
    } catch {
      return { used: 0 };
    }
  }

  async read(): Promise<QuotaInfo> {
    const s = await this.load();
    const remaining = Math.max(0, this.cap - s.used);
    const monthLow = s.monthRemaining !== undefined && s.monthRemaining < MONTH_RESERVE;
    return { day: day(this.now()), used: s.used, cap: this.cap, remaining, monthRemaining: s.monthRemaining, exhausted: remaining < MIN_CALLS_FOR_PLAN || monthLow };
  }

  /** Add the fresh calls one run made. `monthRemaining` is Qloo's own header from that run. */
  async add(calls: number, monthRemaining?: number): Promise<QuotaInfo> {
    if (calls > 0 || monthRemaining !== undefined) {
      const s = await this.load();
      // Never write a counter built on a failed read: it would lock the day.
      if (!s.unreadable) {
        const next: Stored = { used: s.used + Math.max(0, calls), monthRemaining: monthRemaining ?? s.monthRemaining };
        try {
          await this.store.put(this.key(), JSON.stringify(next), 60 * 60 * 24 * 3);
        } catch (e) {
          console.warn(`quota write failed: ${(e as Error).message}`);
        }
      }
    }
    return this.read();
  }
}

/**
 * Per-IP limit on new plans: a fixed one-hour window in KV. Returns true when the
 * address is over the limit. Each check that passes counts as one plan.
 */
export async function ipLimited(store: KeyValueStore, ip: string, perHour: number = DEFAULT_PLANS_PER_HOUR, now: Date = new Date()): Promise<boolean> {
  const key = `rl:v1:${hour(now)}:${ip}`;
  const n = Number((await store.get(key)) ?? 0) || 0;
  if (n >= perHour) return true;
  await store.put(key, String(n + 1), 60 * 60 * 2);
  return false;
}

/** Positive integer from an env var, or the default. */
export function envInt(v: string | number | undefined, dflt: number): number {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}
