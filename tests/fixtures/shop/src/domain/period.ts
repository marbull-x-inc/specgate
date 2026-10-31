import { z } from "zod";
import type { Clock } from "../ports/clock.ts";

/**
 * Closed interval of time.
 * @entity
 * @invariant start <= end
 */
export const zPeriod = z.object({ start: z.date(), end: z.date() }).refine((p) => p.start.getTime() <= p.end.getTime());
export type Period = z.infer<typeof zPeriod>;

/**
 * Tells whether the clock's current time falls inside the period.
 * @remarks Both ends are inclusive so that an action at exactly `end` still counts.
 * @uses Clock
 * @guarantee ok.within Clock.now ∈ [period.start, period.end] gives result = true
 * @guarantee ok.outside Clock.now outside the interval gives result = false
 * @guarantee ok.unbounded period = null (no limit) gives result = true
 * @example
 * ```ts
 * isWithinPeriod(null, { now: () => new Date(0) }) // => true
 * ```
 */
export function isWithinPeriod(period: Period | null, clock: Clock): boolean {
  if (period === null) return true;
  const now = clock.now().getTime();
  return period.start.getTime() <= now && now <= period.end.getTime();
}
