export * as ConfigModelRoutesPlugin from "./model-routes.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { CacheFormat } from "@opencode/schema/model-compatibility"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteExpansion } from "../../model-route-expansion.js"
import { ModelRouteSchedule } from "../../model-route-schedule.js"
import { Provider } from "../../provider.js"
import { ConfigEntryObserver } from "./entry-observer.js"
import { Permission } from "../../permission.js"
import { ModelRouteTuning } from "../../model-route-tuning.js"
import { ModelRouteAutonomy } from "../../model-route-autonomy.js"
import { ModelRouteLog } from "../../model-route-log.js"
import { RouteAdjustTool } from "../../tool/plugin/route-adjust.js"
import { RouteStatsTool } from "../../tool/plugin/route-stats.js"
import { RouteUsageTool } from "../../tool/plugin/route-usage.js"

type SourceModel = {
  readonly ref: Model.Ref
  readonly model: Model.Info
  readonly fixedVariant: boolean
  /** Variant used when the route is selected without an explicit one. */
  readonly defaultVariant?: Model.VariantID
  /** Route-level variant → this target's variant. */
  readonly budget?: ModelRoute.Budget
  readonly variantMap?: Readonly<Record<string, Model.VariantID>>
  /** Prompt-cache format in force for this leaf: its own declaration, else the route's. */
  readonly cacheFormat?: CacheFormat
}

export const Plugin = define({
  id: "opencode.config.model-routes",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const loaded = yield* ConfigEntryObserver.observe(
      config,
      ctx.event,
      ["experimental"],
      ctx.provider.reload().pipe(Effect.andThen(ctx.tool.reload())),
    )

    ModelRouteLog.onCaptureErrorBodies(() => configuredLog(loaded.entries)?.captureErrorBodies === true)

    // Scheduled review of the routing history, off unless configured.
    yield* ModelRouteTuning.schedule(
      () => configuredTuning(loaded.entries),
      () => Array.from(configuredRoutes(loaded.entries).values(), (route) => route.autonomy),
    ).pipe(Effect.forkScoped)

    yield* ctx.tool.transform((editor) => {
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      // Usage is read-only, so it is offered at every autonomy level.
      RouteUsageTool.add(editor, () => ({ routes: configuredRoutes(loaded.entries) }))
      if (!ModelRouteAutonomy.offersTools(Array.from(routes.values(), (route) => route.autonomy))) return
      RouteAdjustTool.add(editor, permission)
      RouteStatsTool.add(editor, permission, () => ({
        routes: configuredRoutes(loaded.entries),
        notes: configuredTuning(loaded.entries)?.notes ?? [],
      }))
    })

    yield* ctx.provider.transform((providers) => {
      if (providers.get(ModelRoute.PROVIDER_ID)) return
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      const windows = configuredWindows(loaded.entries)
      const globalSchedules = weightRulesAcross(configuredSchedules(loaded.entries), windows)
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        providers.list().map((record) => [record.provider.id, record.models] as const),
      )
      const models = Array.from(routes, ([id, route]) => {
        const { leaves: expanded, nodes } = expand(id, routes, definitions, windows)
        if (expanded.length === 0) return undefined
        const first = expanded[0].model
        const leafContext = Math.min(...expanded.map((target) => target.model.limit.context))
        const health = ModelRoute.policy(route.health)
        const targetCacheFormats = expanded.map((target) =>
          target.cacheFormat ? { cacheFormat: target.cacheFormat } : {},
        )
        const info = Model.Info.make({
          ...Model.Info.default(ModelRoute.PROVIDER_ID, Model.ID.make(id)),
          name: route.name?.trim() || id,
          settings: {
            [ModelRoute.SETTING]: {
              id: Model.ID.make(id),
              targets: expanded.map((target) => target.ref),
              targetVariants: expanded.map((target) => ({
                ...(target.defaultVariant ? { default: target.defaultVariant } : {}),
                ...(target.variantMap ? { map: target.variantMap } : {}),
              })),
              // Routes that declare no cache format keep their stored settings unchanged.
              ...(targetCacheFormats.some((item) => item.cacheFormat !== undefined) ? { targetCacheFormats } : {}),
              health,
              nodes,
              ...(route.attempts !== undefined ? { attempts: route.attempts } : {}),
              ...(route.hedgeAfterMs ? { hedgeAfterMs: route.hedgeAfterMs } : {}),
              ...(route.autonomy ? { autonomy: route.autonomy } : {}),
              budgets: expanded.map((target) => target.budget ?? {}),
              ...(globalSchedules.length > 0 ? { schedules: globalSchedules } : {}),
            },
          },
          capabilities: {
            tools: expanded.every((target) => target.model.capabilities.tools),
            input: intersect(expanded.map((target) => target.model.capabilities.input)),
            output: intersect(expanded.map((target) => target.model.capabilities.output)),
          },
          variants: routeVariants(expanded),
          cost: first.cost,
          status: "active",
          limit: {
            context: route.limit?.context !== undefined ? Math.min(route.limit.context, leafContext) : leafContext,
            output: Math.min(...expanded.map((target) => target.model.limit.output)),
            ...(expanded.every((target) => target.model.limit.input !== undefined)
              ? {
                  // The context cap applies to the presented input limit too: compaction
                  // prefers limit.input over limit.context (calculateCeiling), so an uncapped
                  // input would silently bypass the cap whenever targets define one.
                  input:
                    route.limit?.context !== undefined
                      ? Math.min(route.limit.context, ...expanded.map((target) => target.model.limit.input!))
                      : Math.min(...expanded.map((target) => target.model.limit.input!)),
                }
              : {}),
          },
        })
        return info
      }).filter((model): model is Model.Info => model !== undefined)

      if (models.length === 0) return
      providers.add({
        info: {
          ...Provider.Info.empty(ModelRoute.PROVIDER_ID),
          name: "OpenCode routes",
          activation: "enabled",
        },
        models,
      })
    })
  }),
})

function configuredTuning(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<
      ModelRouteTuning.Settings | undefined
    >((found, entry) => entry.info.experimental?.model_route_tuning ?? found, undefined)
}

function configuredLog(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .reduce<
      ConfigModelRoutes.Log | undefined
    >((found, entry) => entry.info.experimental?.model_route_log ?? found, undefined)
}

function configuredRoutes(entries: readonly Entry[]) {
  const routes = new Map<string, ConfigModelRoutes.Route>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.entries(entry.info.experimental?.model_routes ?? {}).forEach(([id, route]) => routes.set(id, route))
    })
  return routes
}

function configuredSchedules(entries: readonly Entry[]) {
  return entries
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.experimental?.model_route_schedules ?? [])
}

/** A named window that cannot be applied is dropped, but never silently (#734): a typo'd or
 * unreadable window name would otherwise remove a target's eligibility gate or a schedule rule
 * with no signal anywhere. The warning names the window and where it was referenced. */
const warnDroppedWindow = (name: string, site: string, reason: string) =>
  console.warn(`model-route window ${JSON.stringify(name)} ${reason} (${site}); it is dropped, not applied`)

/** The named windows defined in config, parsed once so schedules and target gates can reference
 * them by name. An entry with an unreadable window is dropped rather than applied. */
export function configuredWindows(entries: readonly Entry[]) {
  const windows = new Map<string, ModelRouteSchedule.Window>()
  entries
    .filter((entry): entry is Document => entry.type === "document")
    .forEach((entry) => {
      Object.entries(entry.info.experimental?.model_route_windows ?? {}).forEach(([name, window]) => {
        const parsed = ModelRouteSchedule.parse(window)
        if (parsed) {
          windows.set(name, parsed)
          return
        }
        warnDroppedWindow(name, "experimental.model_route_windows", "is defined but cannot be parsed")
      })
    })
  return windows
}

/** A schedule's window: inline (parsed as before), or the name of a configured window.
 * An unknown name resolves to undefined, which drops the rule — with a warning naming it. */
const resolveWindow = (
  when: ConfigModelRoutes.Schedule["when"] | ConfigModelRoutes.GlobalSchedule["when"],
  windows: ReadonlyMap<string, ModelRouteSchedule.Window>,
  site: string,
): ModelRouteSchedule.Window | undefined => {
  if (typeof when !== "string") return ModelRouteSchedule.parse(when)
  const window = windows.get(when)
  if (!window) warnDroppedWindow(when, site, "is not a defined window")
  return window
}

/** A target's eligibility gate, resolved from its `window` against the configured windows.
 * An unknown name drops the gate, leaving the target always eligible — with a warning naming it. */
const gateFor = (
  window: string | { name: string; invert?: boolean } | undefined,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window>,
  site: string,
): ModelRoute.Gate | undefined => {
  if (window === undefined) return undefined
  const name = typeof window === "string" ? window : window.name
  const parsed = windows.get(name)
  if (!parsed) {
    warnDroppedWindow(name, site, "is not a defined window")
    return undefined
  }
  return { name, window: parsed, ...(typeof window !== "string" && window.invert ? { invert: true } : {}) }
}

/** The schedule rules a route declares for its own targets, in a shape the runtime can judge. An
 * entry with an unreadable window, or with nothing to change, is dropped rather than applied. */
export function routeWeightRules(
  route: ConfigModelRoutes.Route,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
): ModelRoute.WeightRule[] {
  return (route.schedules ?? []).flatMap((schedule) => {
    if (schedule.factor === undefined && schedule.weight === undefined) return []
    const window = resolveWindow(
      schedule.when,
      windows,
      schedule.id ? `route schedule ${JSON.stringify(schedule.id)}` : "a route schedule",
    )
    if (!window) return []
    const targets = (schedule.targets ?? []).map((target) => target.trim()).filter(Boolean)
    return [
      {
        ...(schedule.id ? { id: schedule.id } : {}),
        ...(targets.length > 0 ? { match: { targets } } : {}),
        window,
        ...(schedule.factor !== undefined ? { factor: schedule.factor } : {}),
        ...(schedule.weight !== undefined ? { weight: schedule.weight } : {}),
        ...(schedule.note ? { note: schedule.note } : {}),
      },
    ]
  })
}

/** The global schedule rules in a shape the runtime can judge. The route filter stays in the match,
 * so one list serves every route and nested route. An entry with nothing to change is dropped. */
export function weightRulesAcross(
  schedules: readonly ConfigModelRoutes.GlobalSchedule[],
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
): ModelRoute.WeightRule[] {
  return schedules.flatMap((schedule) => {
    if (schedule.factor === undefined && schedule.weight === undefined) return []
    const window = resolveWindow(
      schedule.when,
      windows,
      schedule.id ? `global schedule ${JSON.stringify(schedule.id)}` : "a global schedule",
    )
    if (!window) return []
    const targets = (schedule.targets ?? []).map((target) => target.trim()).filter(Boolean)
    const providers = (schedule.providers ?? []).map((provider) => provider.trim()).filter(Boolean)
    const models = (schedule.models ?? []).map((model) => model.trim()).filter(Boolean)
    const routes = (schedule.routes ?? []).map((route) => route.trim()).filter(Boolean)
    const match = {
      ...(targets.length > 0 ? { targets } : {}),
      ...(providers.length > 0 ? { providers } : {}),
      ...(models.length > 0 ? { models } : {}),
      ...(routes.length > 0 ? { routes } : {}),
    }
    return [
      {
        ...(schedule.id ? { id: schedule.id } : {}),
        ...(Object.keys(match).length > 0 ? { match } : {}),
        window,
        ...(schedule.factor !== undefined ? { factor: schedule.factor } : {}),
        ...(schedule.weight !== undefined ? { weight: schedule.weight } : {}),
        ...(schedule.note ? { note: schedule.note } : {}),
      },
    ]
  })
}

export function expand(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
  windows: ReadonlyMap<string, ModelRouteSchedule.Window> = new Map(),
) {
  const result: SourceModel[] = []
  const nodes: ModelRoute.Node[] = []
  const leafByKey = new Map<string, number>()

  // Each route becomes a group node with its own selection mode and weights, so a weighted route
  // nested in another is chosen as one unit and then splits among its own members.
  const visit = (
    routeID: string,
    inheritedVariant: Model.VariantID | undefined,
    trail: ReadonlySet<string>,
    inheritedCacheFormat: CacheFormat | undefined,
  ): number | undefined => {
    if (trail.has(routeID)) return
    const current = routes.get(routeID)
    if (!current) return
    const nextTrail = new Set(trail).add(routeID)
    const nodeIndex = nodes.length
    const node: {
      routeID: string
      selection: ModelRoute.Node["selection"]
      weights: number[]
      schedules: ModelRoute.WeightRule[]
      children: ModelRoute.Node["children"][number][]
    } = {
      routeID,
      selection: ModelRouteAutonomy.usesRules(current.autonomy) ? (current.selection ?? "ordered") : "ordered",
      weights: [],
      schedules: routeWeightRules(current, windows),
      children: [],
    }
    nodes.push(node)
    const attached = new Set<string>()
    const attach = (child: ModelRoute.Node["children"][number], key: string) => {
      node.children.push(child)
      node.weights.push(ModelRouteAutonomy.usesRules(current.autonomy) ? (current.weights?.[key] ?? 1) : 1)
    }
    for (const target of current.targets) {
      const spec = targetSpec(target)
      const ref = targetRef(spec.model)
      if (spec.until !== undefined && Date.now() >= spec.until) continue
      if (ref.providerID === ModelRoute.PROVIDER_ID) {
        const child = visit(
          ref.id,
          ref.variant ?? inheritedVariant,
          nextTrail,
          spec.cache_format ?? current.cache_format ?? inheritedCacheFormat,
        )
        if (child !== undefined) {
          const gate = gateFor("window" in spec ? spec.window : undefined, windows, `route ${JSON.stringify(routeID)}`)
          attach({ node: child, ...(gate ? { gate } : {}) }, `${ModelRoute.PROVIDER_ID}/${ref.id}`)
        }
        continue
      }
      // A door-set target (`*/model`, #637) runs its model on every door whose catalog lists
      // it, minus the target's exclusions; any other target names exactly one provider. The
      // per-leaf logic below is identical either way, with the leaf's own provider.
      const doors: ReadonlyArray<readonly [Provider.ID, ReadonlyMap<string, Model.Info> | undefined]> =
        ref.providerID === "*"
          ? ModelRouteExpansion.matchingProviders(
              definitions,
              "exclude" in spec ? (spec.exclude ?? []) : [],
              ModelRoute.PROVIDER_ID,
            )
          : [[ref.providerID, definitions.get(ref.providerID)]]
      for (const [door, doorModels] of doors) {
        for (const [id, model] of ModelRouteExpansion.matchingModels(ref.id, doorModels)) {
        if (!model.enabled) continue
        const requested = ref.variant ?? inheritedVariant
        // A pinned variant is producible natively or through the target's remap table, matching
        // routeVariants and the resolver: a remap the model can produce wins, else the native
        // variant, else the leaf is pruned.
        const remapped = requested ? spec.variants?.[requested] : undefined
        const variant =
          requested === undefined
            ? undefined
            : remapped !== undefined && model.variants.some((item) => item.id === remapped)
              ? Model.VariantID.make(remapped)
              : model.variants.some((item) => item.id === requested)
                ? requested
                : undefined
        if (requested && !variant) continue
        const resolved = Model.Ref.make({
          providerID: door,
          id: Model.ID.make(id),
          ...(variant ? { variant } : {}),
        })
        const key = `${resolved.providerID}/${resolved.id}${resolved.variant ? `#${resolved.variant}` : ""}`
        if (attached.has(key)) continue
        attached.add(key)
        const gate = gateFor("window" in spec ? spec.window : undefined, windows, `route ${JSON.stringify(routeID)}`)
        const leafKey = `${resolved.providerID}/${resolved.id}`
        const existing = leafByKey.get(key)
        if (existing !== undefined) {
          // First reach wins for the leaf itself; a different node re-attaches it by index.
          attach({ leaf: existing, ...(gate ? { gate } : {}) }, leafKey)
          continue
        }
        const defaultVariant =
          spec.defaultVariant && model.variants.some((item) => item.id === spec.defaultVariant)
            ? Model.VariantID.make(spec.defaultVariant)
            : undefined
        const variantMap = Object.fromEntries(
          Object.entries(spec.variants ?? {}).flatMap(([from, to]) =>
            model.variants.some((item) => item.id === to) ? [[from, Model.VariantID.make(to)] as const] : [],
          ),
        )
        leafByKey.set(key, result.length)
        attach({ leaf: result.length, ...(gate ? { gate } : {}) }, leafKey)
        // A leaf's own cache_format wins, then the route that declared it, then an enclosing
        // route's. The first route to reach a shared model fixes it for that leaf.
        const cacheFormat = spec.cache_format ?? current.cache_format ?? inheritedCacheFormat
        // Budgets belong to the target: the outermost route that declares one wins, wherever the
        // target was first reached.
        const budget = plainBudget(
          [...nextTrail]
            .filter((id) => ModelRouteAutonomy.usesRules(routes.get(id)?.autonomy))
            .map((id) => routes.get(id)?.budgets?.[leafKey])
            .find((value) => value !== undefined),
        )
        result.push({
          ...(budget ? { budget } : {}),
          ref: resolved,
          model,
          fixedVariant: ref.variant !== undefined || inheritedVariant !== undefined,
          ...(defaultVariant ? { defaultVariant } : {}),
          ...(Object.keys(variantMap).length ? { variantMap } : {}),
          ...(cacheFormat ? { cacheFormat } : {}),
        })
        }
      }
    }
    return node.children.length > 0 ? nodeIndex : undefined
  }

  visit(id, undefined, new Set(), undefined)
  return { leaves: result, nodes }
}

/** Settings are stored as JSON, which has no undefined: keep only the allowances actually set. */
function plainBudget(budget: ConfigModelRoutes.Budget | undefined): ModelRoute.Budget | undefined {
  if (!budget) return undefined
  const entries = Object.entries(budget).filter(([, value]) => typeof value === "number")
  return entries.length > 0 ? (Object.fromEntries(entries) as ModelRoute.Budget) : undefined
}

function targetSpec(target: ConfigModelRoutes.Target) {
  return typeof target === "string" || "providerID" in target ? { model: target } : target
}

function targetRef(target: ConfigModel.Selection): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(target.providerID),
    id: Model.ID.make(target.model),
    ...(target.variant ? { variant: Model.VariantID.make(target.variant) } : {}),
  })
}

function intersect(values: readonly (readonly string[])[]) {
  const [first, ...rest] = values
  return (first ?? []).filter((value) => rest.every((items) => items.includes(value)))
}

export function routeVariants(targets: readonly SourceModel[]) {
  if (targets.some((target) => target.fixedVariant)) return []
  // A route-level variant is offered when every target can produce it, either natively or through
  // its remap table.
  return intersect(
    targets.map((target) => {
      const native = target.model.variants.map((variant) => variant.id)
      const remapped = Object.keys(target.variantMap ?? {})
      return [...new Set([...native, ...remapped])]
    }),
  ).map((id) => ({ id: Model.VariantID.make(id) }))
}
