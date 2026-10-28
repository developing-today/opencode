export * as ModelUsage from "./model-usage.js"

import type { ModelPlan } from "./model-plan.js"

/**
 * What routed work used, from the route history: per session, per provider and model, per pool, per day, and
 * against each plan's quota windows. Pure arithmetic over rows read from the history, so it can be tested
 * without a database. `metered` is input, output and reasoning tokens together, which is the figure plans
 * usually meter; cache reads and writes are kept apart because providers price them differently.
 */

export interface Totals {
  readonly requests: number
  readonly failures: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly costUsd: number
}

export const zero: Totals = {
  requests: 0,
  failures: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
}

export const sum = (rows: readonly Totals[]): Totals =>
  rows.reduce<Totals>(
    (total, row) => ({
      requests: total.requests + row.requests,
      failures: total.failures + row.failures,
      input: total.input + row.input,
      output: total.output + row.output,
      reasoning: total.reasoning + row.reasoning,
      cacheRead: total.cacheRead + row.cacheRead,
      cacheWrite: total.cacheWrite + row.cacheWrite,
      costUsd: total.costUsd + row.costUsd,
    }),
    zero,
  )

export const metered = (totals: Totals) => totals.input + totals.output + totals.reasoning

/** The amount of a quota unit that these totals used, or null when the unit cannot be read from requests. */
export const usedOf = (unit: string, totals: Totals): number | null => {
  if (unit === "requests" || unit === "messages") return totals.requests
  if (unit === "tokens") return metered(totals)
  if (unit === "usd") return totals.costUsd
  return null
}

export const percentOf = (used: number | null, limit: number | undefined) =>
  used === null || limit === undefined || limit <= 0 ? null : Math.round((used / limit) * 1000) / 10

export interface SessionRow extends Totals {
  readonly sessionID: string
  readonly first: number
  readonly last: number
}

export interface SessionTargetRow extends Totals {
  readonly sessionID: string
  readonly routeID: string
  readonly providerID: string
  readonly modelID: string
}

export interface TargetRow extends Totals {
  readonly providerID: string
  readonly modelID: string
  readonly sessions: number
  readonly first: number
  readonly last: number
}

export interface DayRow extends Totals {
  readonly day: string
  readonly providerID: string
  readonly modelID: string
}

/** How often a pool offered a target in its selections, and how often it chose it. */
export interface OfferRow {
  readonly routeID: string
  readonly target: string
  readonly offered: number
  readonly chosen: number
}

export interface PoolState {
  readonly routeID: string
  /** `used`: chosen at least once. `offered-not-chosen`: eligible but never chosen. `configured-not-reached`: listed in
   * the pool but never eligible in the window, so a failover, a cooldown, a disabled provider or a typo is the usual cause. */
  readonly state: "used" | "offered-not-chosen" | "configured-not-reached"
  readonly offered: number
  readonly chosen: number
}

export const poolStates = (
  target: string,
  offers: readonly OfferRow[],
  configured: ReadonlyMap<string, readonly string[]>,
): PoolState[] => {
  const routes = new Set<string>()
  for (const [routeID, targets] of configured) if (targets.includes(target)) routes.add(routeID)
  for (const offer of offers) if (offer.target === target) routes.add(offer.routeID)
  return [...routes].sort().map((routeID) => {
    const offer = offers.find((item) => item.routeID === routeID && item.target === target)
    const offered = offer?.offered ?? 0
    const chosen = offer?.chosen ?? 0
    const state = chosen > 0 ? "used" : offered > 0 ? "offered-not-chosen" : "configured-not-reached"
    return { routeID, state, offered, chosen }
  })
}

export interface TargetReport extends Totals {
  readonly target: string
  readonly providerID: string
  readonly modelID: string
  readonly sessions: number
  readonly pools: readonly PoolState[]
}

/** A target string is "provider/model", split at the first slash (model ids may contain
 * further slashes). A slash-less target — a bare or typo'd pool entry, exactly what the
 * configured-not-reached report exists to surface — has no provider: the whole string is
 * the model id and the provider is empty, instead of slice(0, -1) silently dropping the
 * string's last character into a provider that does not exist. Shared with the route_usage
 * tool's filtering so the two splits cannot drift. */
export const splitTarget = (target: string): { providerID: string; modelID: string } => {
  const slash = target.indexOf("/")
  return slash === -1
    ? { providerID: "", modelID: target }
    : { providerID: target.slice(0, slash), modelID: target.slice(slash + 1) }
}

/** Every target that was used in the window, plus every configured target that was not, so an idle one shows. */
export const targetReports = (
  rows: readonly TargetRow[],
  configuredTargets: readonly string[],
  offers: readonly OfferRow[],
  configured: ReadonlyMap<string, readonly string[]>,
): TargetReport[] => {
  const used = new Map(rows.map((row) => [`${row.providerID}/${row.modelID}`, row]))
  const targets = [...new Set([...used.keys(), ...configuredTargets])]
  return targets.map((target) => {
    const row = used.get(target)
    const { providerID, modelID } = splitTarget(target)
    return {
      target,
      providerID,
      modelID,
      requests: row?.requests ?? 0,
      failures: row?.failures ?? 0,
      input: row?.input ?? 0,
      output: row?.output ?? 0,
      reasoning: row?.reasoning ?? 0,
      cacheRead: row?.cacheRead ?? 0,
      cacheWrite: row?.cacheWrite ?? 0,
      costUsd: row?.costUsd ?? 0,
      sessions: row?.sessions ?? 0,
      pools: poolStates(target, offers, configured),
    }
  })
}

/** One session's share of a plan window's limit: what the session used of the window, in the window's unit. */
export interface SessionWindowUse {
  readonly plan: string
  readonly window: string
  readonly unit: string
  readonly used: number | null
  readonly percent: number | null
}

export interface SessionReport extends SessionRow {
  readonly pools: readonly string[]
  readonly targets: readonly {
    readonly target: string
    readonly routeID: string
    readonly requests: number
    readonly metered: number
    readonly costUsd: number
  }[]
  readonly windows: readonly SessionWindowUse[]
}

export const sessionReports = (
  sessions: readonly SessionRow[],
  rows: readonly SessionTargetRow[],
  windows: readonly {
    readonly plan: ModelPlan.Plan
    readonly window: ModelPlan.QuotaWindow
    /** This session's per-target rows inside the plan window's own lookback, when the caller read them
     * separately; the share is computed from these, not from the report window's rows. */
    readonly rows?: readonly SessionTargetRow[]
  }[] = [],
): SessionReport[] =>
  sessions.map((session) => {
    const own = rows.filter((row) => row.sessionID === session.sessionID)
    return {
      ...session,
      pools: [...new Set(own.map((row) => row.routeID))].sort(),
      targets: own.map((row) => ({
        target: `${row.providerID}/${row.modelID}`,
        routeID: row.routeID,
        requests: row.requests,
        metered: metered(row),
        costUsd: row.costUsd,
      })),
      windows: windows.map(({ plan, window, rows: windowRows }) => {
        const scoped = (windowRows ?? own).filter((row) => row.sessionID === session.sessionID)
        const used = usedOf(window.unit, sum(scoped.filter((row) => row.providerID === plan.providerID)))
        return {
          plan: plan.id,
          window: window.name,
          unit: window.unit,
          used,
          percent: percentOf(used, window.limit),
        }
      }),
    }
  })

export interface DayReport {
  readonly day: string
  readonly requests: number
  readonly metered: number
  readonly costUsd: number
  readonly providers: Readonly<
    Record<string, { readonly requests: number; readonly metered: number; readonly costUsd: number }>
  >
}

/** One request as far as turn stitching needs it: the link to the attempt it continues, plus what it cost. */
export interface TurnAttemptRow {
  readonly id: number
  readonly continuationOf: number | null
  readonly continuationIndex: number | null
  readonly assistantMessageID: string | null
  readonly sessionID: string | null
  readonly timeStarted: number
  readonly timeEnded: number
  readonly outcome: string
  readonly input: number | null
  readonly output: number | null
  readonly reasoning: number | null
  readonly cacheRead: number | null
  readonly cacheWrite: number | null
  readonly costUsd: number | null
}

export interface TurnRow extends Totals {
  /** Id of the attempt that started the turn; for a partial turn whose root fell outside the window, the id it names. */
  readonly rootID: number
  readonly sessionID: string | null
  /** Response segments: the root attempt plus each output-token-limit continuation, however many requests each took. */
  readonly chunks: number
  readonly first: number
  readonly last: number
  readonly durationMs: number
}

/** Rolls attempts up into turns: a root attempt plus every attempt whose `continuation_of` names it. Retries and hedge
 * legs share the assistant message of the chunk they belong to, so the newest standalone attempt of a message is that
 * chunk's root and the others join it; `requests` therefore counts every billed attempt, while `chunks` counts response
 * segments, so a response split by output-token-limit continuations reads as one cost instead of several rows. */
export const turns = (rows: readonly TurnAttemptRow[]): TurnRow[] => {
  // Each chunk's root is the newest standalone attempt of its assistant message; retries and hedge legs of the same
  // chunk share the message and join it instead of forming turns of their own.
  const roots = new Map<string, number>()
  for (const row of rows) {
    if ((row.continuationIndex ?? 0) !== 0 || row.assistantMessageID === null) continue
    roots.set(row.assistantMessageID, Math.max(roots.get(row.assistantMessageID) ?? 0, row.id))
  }
  const rootOf = (row: TurnAttemptRow) =>
    row.continuationOf ?? (row.assistantMessageID === null ? row.id : (roots.get(row.assistantMessageID) ?? row.id))
  const grouped = new Map<number, TurnAttemptRow[]>()
  for (const row of rows) {
    const rootID = rootOf(row)
    const group = grouped.get(rootID)
    if (group) group.push(row)
    else grouped.set(rootID, [row])
  }
  return [...grouped]
    .map(([rootID, attempts]) => {
      const root = attempts.find((attempt) => attempt.id === rootID)
      const totals = sum(
        attempts.map((attempt) => ({
          requests: 1,
          failures: attempt.outcome === "failure" || attempt.outcome === "timeout" ? 1 : 0,
          input: attempt.input ?? 0,
          output: attempt.output ?? 0,
          reasoning: attempt.reasoning ?? 0,
          cacheRead: attempt.cacheRead ?? 0,
          cacheWrite: attempt.cacheWrite ?? 0,
          costUsd: attempt.costUsd ?? 0,
        })),
      )
      const first = Math.min(...attempts.map((attempt) => attempt.timeStarted))
      const last = Math.max(...attempts.map((attempt) => attempt.timeEnded))
      return {
        ...totals,
        rootID,
        sessionID: root?.sessionID ?? attempts[0]?.sessionID ?? null,
        chunks: 1 + Math.max(...attempts.map((attempt) => attempt.continuationIndex ?? 0)),
        first,
        last,
        durationMs: last - first,
      }
    })
    .sort((a, b) => b.last - a.last || b.rootID - a.rootID)
}

export const dayReports = (rows: readonly DayRow[]): DayReport[] => {
  const days = new Map<string, DayRow[]>()
  for (const row of rows) days.set(row.day, [...(days.get(row.day) ?? []), row])
  return [...days].map(([day, dayRows]) => {
    const providers = new Map<string, { requests: number; metered: number; costUsd: number }>()
    for (const row of dayRows) {
      const current = providers.get(row.providerID) ?? { requests: 0, metered: 0, costUsd: 0 }
      providers.set(row.providerID, {
        requests: current.requests + row.requests,
        metered: current.metered + metered(row),
        costUsd: current.costUsd + row.costUsd,
      })
    }
    const total = sum(dayRows)
    return {
      day,
      requests: total.requests,
      metered: metered(total),
      costUsd: total.costUsd,
      providers: Object.fromEntries(providers),
    }
  })
}

export interface WindowReport {
  readonly plan: string
  readonly window: string
  readonly unit: string
  readonly limit: number | null
  readonly windowHours: number | null
  /** What the window has used in its last `windowHours`, in its own unit. */
  readonly used: number | null
  readonly percent: number | null
  readonly remaining: number | null
  readonly resetRule: string | null
}

/** How much of one quota window the usage in its last `windowHours` has taken. Usage is attributed to every plan
 * of the provider, so a provider with several plans should keep one plan record, or say which is which in notes. */
export const windowReport = (plan: ModelPlan.Plan, window: ModelPlan.QuotaWindow, totals: Totals): WindowReport => {
  const used = usedOf(window.unit, totals)
  const limit = window.limit ?? null
  return {
    plan: plan.id,
    window: window.name,
    unit: window.unit,
    limit,
    windowHours: window.windowHours ?? null,
    used,
    percent: percentOf(used, window.limit),
    remaining: used === null || limit === null ? null : Math.max(0, limit - used),
    resetRule: window.resetRule ?? null,
  }
}
