export * as RouteUsageTool from "./route-usage.js"

import type { ToolEditor } from "@opencode/plugin/effect/tool"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Option, Schema } from "effect"
import { ModelPlan } from "../../model-plan.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { ModelRouteReview } from "../../model-route-review.js"
import { ModelUsage } from "../../model-usage.js"

export const name = "route_usage"

export const description = `Read what routed work has used: totals per provider and model, per session (requests, tokens, cost, the pools and models it used), per day, and each plan's quota windows with the share used in its last window.

Use it for questions like "which sessions used the most", "did any pool use this provider", "how much of my Claude window is gone", or "what did this week cost". Set \`hours\` for the window (default 168; up to a year). Set \`provider\` or \`model\` to narrow the totals, \`route\` to one pool, or \`session\` to one session. Every target lists each pool it belongs to: used, offered but never chosen, or configured but never reached. The history is kept indefinitely, so a longer window is always available.`

export const Input = Schema.Struct({
  hours: Schema.Finite.check(Schema.isBetween({ minimum: 0.1, maximum: 24 * 366 })).pipe(Schema.optional),
  provider: Schema.String.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional).annotate({ description: "A model id, without its provider." }),
  route: Schema.String.pipe(Schema.optional).annotate({ description: "A pool id, such as cheap-fast." }),
  session: Schema.String.pipe(Schema.optional),
  limit: Schema.Finite.check(Schema.isBetween({ minimum: 1, maximum: 200 })).pipe(Schema.optional),
})
export type Input = typeof Input.Type

export const Output = Schema.Struct({
  targets: Schema.Array(Schema.Unknown),
  sessions: Schema.Array(Schema.Unknown),
  days: Schema.Array(Schema.Unknown),
  plans: Schema.Array(Schema.Unknown),
  noDatabase: Schema.Boolean,
})

/** What the configuration says about pools, read when the tool runs. */
export interface Source {
  readonly routes: ReadonlyMap<string, ConfigModelRoutes.Route>
}

export interface Options {
  readonly dataDir?: string
  readonly now?: () => number
}

const NO_SOURCE: Source = { routes: new Map() }

const splitTarget = (target: string) => {
  const slash = target.indexOf("/")
  return { providerID: target.slice(0, slash), modelID: target.slice(slash + 1) }
}

export const collect = (input: Input, source: Source = NO_SOURCE, options: Options = {}) =>
  Effect.gen(function* () {
    const now = options.now?.() ?? Date.now()
    const hours = input.hours ?? 168
    const since = now - hours * 3_600_000
    const pools = new Map<string, readonly string[]>()
    for (const [id, route] of source.routes) {
      if (input.route === undefined || id === input.route) pools.set(id, ModelRouteReview.configured(route).targets)
    }
    const matches = (target: { readonly providerID: string; readonly modelID: string }) =>
      (input.provider === undefined || target.providerID === input.provider) &&
      (input.model === undefined || target.modelID === input.model)

    let plans: readonly ModelPlan.Plan[] = []
    let planError: string | undefined
    try {
      plans = ModelPlan.readStore(options.dataDir).plans.filter(
        (plan) => input.provider === undefined || plan.providerID === input.provider,
      )
    } catch (error) {
      planError = error instanceof Error ? error.message : String(error)
    }
    const windows = plans.flatMap((plan) =>
      plan.quotas.flatMap((window) => (window.windowHours === undefined ? [] : [{ plan, window }])),
    )

    const read = yield* ModelRouteLog.withDb((db) =>
      Effect.gen(function* () {
        const sessions = yield* ModelRouteLog.sessionUsage(db, since, input.limit ?? 20, input.session)
        const sessionIDs = sessions.flatMap((row) => (row.sessionID === null ? [] : [row.sessionID]))
        const sessionTargets = yield* ModelRouteLog.sessionTargetUsage(db, since, sessionIDs)
        const windowSessionTargets: (readonly ModelUsage.SessionTargetRow[])[] = []
        for (const { window } of windows) {
          windowSessionTargets.push(
            (yield* ModelRouteLog.sessionTargetUsage(
              db,
              now - (window.windowHours ?? 0) * 3_600_000,
              sessionIDs,
            )) as ModelUsage.SessionTargetRow[],
          )
        }
        const targets = yield* ModelRouteLog.targetUsage(db, since)
        const days = yield* ModelRouteLog.dailyUsage(db, since)
        const offers = (yield* ModelRouteLog.offerUsage(db, since, input.route)) as ModelUsage.OfferRow[]
        const windowTotals: { plan: string; window: string; totals: ModelUsage.Totals }[] = []
        for (const { plan, window } of windows) {
          const rows = yield* ModelRouteLog.targetUsage(db, now - (window.windowHours ?? 0) * 3_600_000)
          windowTotals.push({
            plan: plan.id,
            window: window.name,
            totals: ModelUsage.sum(rows.filter((row) => row.providerID === plan.providerID)),
          })
        }
        return { sessions, sessionTargets, targets, days, offers, windowTotals, windowSessionTargets }
      }).pipe(Effect.orDie),
    )
    const history = Option.getOrUndefined(read)

    const configuredTargets = [...new Set([...pools.values()].flat())]
    const offers = history?.offers ?? []
    const targets = ModelUsage.targetReports(
      (history?.targets ?? []).filter(matches),
      configuredTargets.filter((target) => matches(splitTarget(target))),
      offers,
      pools,
    )
    const sessions = ModelUsage.sessionReports(
      (history?.sessions ?? []).flatMap((row) =>
        row.sessionID === null ? [] : [{ ...row, sessionID: row.sessionID }],
      ),
      (history?.sessionTargets ?? []).flatMap((row) =>
        row.sessionID === null ? [] : [{ ...row, sessionID: row.sessionID }],
      ),
      windows.map(({ plan, window }, index) => ({
        plan,
        window,
        rows: (history?.windowSessionTargets[index] ?? []).flatMap((row) =>
          row.sessionID === null ? [] : [{ ...row, sessionID: row.sessionID }],
        ),
      })),
    ).filter(
      (session) =>
        (input.provider === undefined && input.model === undefined) ||
        session.targets.some((item) => matches(splitTarget(item.target))),
    )
    const days = ModelUsage.dayReports((history?.days ?? []).filter(matches))
    const planReports = windows.map(({ plan, window }) => {
      const found = history?.windowTotals.find((item) => item.plan === plan.id && item.window === window.name)
      const report = ModelUsage.windowReport(plan, window, found?.totals ?? ModelUsage.zero)
      return history === undefined ? { ...report, used: null, percent: null, remaining: null } : report
    })
    return {
      hours,
      since: new Date(since).toISOString(),
      noDatabase: history === undefined,
      planError,
      targets,
      sessions,
      days,
      plans: planReports,
    }
  })

const money = (value: number) => `$${value.toFixed(2)}`

const describe = (report: Effect.Success<ReturnType<typeof collect>>) => {
  const lines: string[] = []
  if (report.noDatabase) lines.push("Routing history is unavailable: no database is attached.")
  if (report.planError) lines.push(`Plan records could not be read: ${report.planError}`)
  lines.push(`Window: the last ${report.hours} hours, from ${report.since}.`)
  lines.push(`${report.targets.length} targets, ${report.sessions.length} sessions listed, ${report.days.length} days.`)
  for (const target of report.targets) {
    const pools = target.pools.map(
      (pool) => `${pool.routeID} ${pool.state} (offered ${pool.offered}, chosen ${pool.chosen})`,
    )
    lines.push(
      `${target.target}: ${target.requests} requests (${target.failures} failed), ${ModelUsage.metered(target)} metered tokens, ${money(target.costUsd)}, ${target.sessions} sessions; pools: ${pools.join("; ") || "none"}`,
    )
  }
  for (const session of report.sessions) {
    const shares = session.windows
      .filter((item) => item.percent !== null)
      .map((item) => `${item.percent}% of ${item.plan} ${item.window}`)
    lines.push(
      `session ${session.sessionID} last ${new Date(session.last).toISOString().slice(0, 16)}: ${session.requests} requests, ${ModelUsage.metered(session)} metered tokens, ${money(session.costUsd)}; pools ${session.pools.join(", ") || "none"}; models ${session.targets.map((item) => `${item.target} x${item.requests}`).join(", ") || "none"}${shares.length > 0 ? `; used ${shares.join(", ")}` : ""}`,
    )
  }
  for (const day of report.days.slice(-14)) {
    lines.push(`${day.day}: ${day.requests} requests, ${day.metered} metered tokens, ${money(day.costUsd)}`)
  }
  for (const plan of report.plans) {
    const limit = plan.limit === null ? "no limit recorded" : `of ${plan.limit} ${plan.unit}`
    lines.push(
      `plan ${plan.plan} window ${plan.window}${plan.windowHours === null ? "" : ` (${plan.windowHours}h)`}: ${plan.used === null ? "usage unknown" : `${plan.used} used ${limit}`}${plan.percent === null ? "" : `, ${plan.percent}% used`}${plan.resetRule === null ? "" : `; resets ${plan.resetRule}`}`,
    )
  }
  return lines.join("\n")
}

export const add = (editor: ToolEditor, source: () => Source = () => NO_SOURCE, options: Options = {}) =>
  editor.add({
    name,
    options: { codemode: false },
    description,
    input: Input,
    output: Output,
    execute: (input) =>
      Effect.gen(function* () {
        const report = yield* collect(input, source(), options)
        return {
          output: {
            targets: report.targets,
            sessions: report.sessions,
            days: report.days,
            plans: report.plans,
            noDatabase: report.noDatabase,
          },
          content: describe(report),
        }
      }),
  })
