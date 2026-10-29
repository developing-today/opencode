export * as QuotaSnapshot from "./quota-snapshot.js"

import { ModelUsage } from "./model-usage.js"
import { ModelRouteLimits } from "./model-route-limits.js"
import type { ModelPlan } from "./model-plan.js"

/**
 * One quota signal for every consumer (design #587, phase 1 in #588): a pure derivation of a snapshot per
 * plan window from the plan store plus recorded usage, reusing `ModelUsage.windowReport` for the
 * percent/remaining arithmetic instead of duplicating it. Snapshots are derived, never stored: the stored
 * truth stays plans + route history, exactly as `windowReport` already treats it. Nothing in the selection
 * path reads snapshots yet.
 *
 * The staleness contract is defined here once: one configured max age (a per-plan override is allowed)
 * decides `stale` for every consumer. A snapshot whose `percent` is null or that is stale is *unknown* —
 * never headroom and never a wall; what a consumer does with unknown is its own configured fallback.
 */

export interface Snapshot {
  readonly planID: string
  readonly window: string
  readonly providerID: string
  /** Percent of the window's limit used, or null when it cannot be derived — never a guessed number. */
  readonly percent: number | null
  readonly remaining: number | null
  /** Epoch ms of the next reset when the window's reset data yields one; null otherwise. */
  readonly resetAt: number | null
  /** When the underlying usage data was current (epoch ms). */
  readonly observedAt: number
  readonly stale: boolean
}

export interface Options {
  /** The clock the derivation is pure in: same inputs plus the same `now` give the same snapshots. */
  readonly now: number
  /** Max age before an observation is stale. One definition for all consumers; default one hour. */
  readonly maxAgeMs?: number
  /** Per-plan max-age overrides, keyed by plan id — the one definition above, overridden per plan. */
  readonly perPlanMaxAgeMs?: Readonly<Record<string, number>>
}

/** The default staleness max age: one hour, the fleet's placement-read discipline (#587 open question). */
export const DEFAULT_MAX_AGE_MS = 3_600_000

export interface Input {
  readonly plan: ModelPlan.Plan
  readonly window: ModelPlan.QuotaWindow
  /** Usage totals for this window over its last `windowHours`, as `windowReport` consumes them. */
  readonly totals: ModelUsage.Totals
  /** When `totals` were current (epoch ms). */
  readonly observedAt: number
}

/**
 * The next reset a window's reset data yields a concrete time for: an explicit `resetAt` recorded on the
 * window, or a `daily HH:MM UTC` rule (the next occurrence after `now`). Anything else — `rolling`,
 * free-text rules — has no single derivable instant and yields null rather than a guess. An explicit
 * `resetAt` is a recorded fact, not a derivation, so it is returned as recorded even when it is already
 * in the past; consumers judge staleness from `now`, the value is never discarded or rolled forward.
 */
const resetAtOf = (window: ModelPlan.QuotaWindow, now: number): number | null => {
  if (window.resetAt !== undefined) {
    return ModelRouteLimits.parseAbsoluteTime(window.resetAt) ?? null
  }
  const daily = window.resetRule?.match(/^daily (\d{1,2}):(\d{2}) UTC$/)
  if (daily) {
    const hour = Number(daily[1])
    const minute = Number(daily[2])
    // Out-of-range components have no derivable instant: yield null rather than letting
    // setUTCHours roll the overflow into a fabricated reset in the next hour or day.
    if (hour > 23 || minute > 59) return null
    const at = new Date(now)
    at.setUTCHours(hour, minute, 0, 0)
    return at.getTime() <= now ? at.getTime() + 86_400_000 : at.getTime()
  }
  return null
}

export const derive = (input: Input, options: Options): Snapshot => {
  const report = ModelUsage.windowReport(input.plan, input.window, input.totals)
  // Without `windowHours` the totals cannot be attributed to this window (#550), so a percent computed
  // from them would not be a reading of the window: report unknown instead of that number.
  const windowed = input.window.windowHours !== undefined
  // Own-property resolution only: a plain lookup reads through the prototype chain, so a plan
  // named e.g. "constructor" would inherit the Object function as its max age instead of falling
  // through to the configured/default max age, and would never go stale (#824).
  const perPlan = options.perPlanMaxAgeMs
  const override = perPlan && Object.hasOwn(perPlan, input.plan.id) ? perPlan[input.plan.id] : undefined
  const maxAge = override ?? options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  return {
    planID: input.plan.id,
    window: input.window.name,
    providerID: input.plan.providerID,
    percent: windowed ? report.percent : null,
    remaining: windowed ? report.remaining : null,
    resetAt: resetAtOf(input.window, options.now),
    observedAt: input.observedAt,
    stale: options.now - input.observedAt > maxAge,
  }
}

/** One snapshot per quota window of every plan, in plan then window order. */
export const deriveAll = (
  plans: readonly ModelPlan.Plan[],
  totals: (plan: ModelPlan.Plan, window: ModelPlan.QuotaWindow) => ModelUsage.Totals,
  observedAt: number,
  options: Options,
): Snapshot[] =>
  plans.flatMap((plan) =>
    plan.quotas.map((window) => derive({ plan, window, totals: totals(plan, window), observedAt }, options)),
  )

/** Whether a snapshot carries a usable reading: a known percent that is still fresh. */
export const known = (snapshot: Snapshot): boolean => snapshot.percent !== null && !snapshot.stale
