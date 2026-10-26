export * as ConfigModelRoutesPlugin from "./model-routes.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import { ConfigModel } from "@opencode/schema/config/model"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Result } from "effect"
import { Config } from "../../config.js"
import { Model } from "../../model.js"
import { ModelRoute } from "../../model-route.js"
import { ModelRouteMatch } from "../../model-route-match.js"
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
  readonly budget?: ModelRoute.Budget
  /** Route-level variant → this target's variant, or `false` when the target sits that level out. */
  readonly variantMap?: Readonly<Record<string, Model.VariantID | false>>
}

/** What the pools a pool is nested in hand down to its members. */
type Enclosing = {
  /** The exclusions of every pool on the way in. */
  readonly excludes: readonly ModelRouteMatch.Predicate[]
  /** The variantRules of the pools on the way in above any pin, outermost first. They apply to the levels the
   * expanded pool is selected at, so a member keeps what they say. */
  readonly rules: readonly ModelRouteMatch.Rule[]
  /** Each pin on the way in, outermost first. */
  readonly pins: readonly Pin[]
}

/** A nested pool entered as `opencode-route/<id>#<level>`, with the pools nested in it that have no pin of their
 * own. They run only at that level, so their remaps and rules decide only whether a member sits it out, and such
 * a member is left out. */
type Pin = {
  readonly level: Model.VariantID
  /** The variantRules of the pools at this pin, outermost first. */
  readonly rules: readonly ModelRouteMatch.Rule[]
  /** The members left out here, as a later target names one (`provider/model`, with that target's own
   * `#variant`) and as a model. Nothing later at this pin brings one back, as a member placed here would stop
   * it; a pool above the pin may still take the model on its own terms. */
  readonly leftOut: { readonly targets: Set<string>; readonly models: Set<string> }
}

const POOL_PREFIX = `${ModelRoute.PROVIDER_ID}/`

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

    const runFork = Effect.runForkWith(yield* Effect.context())
    // Transforms replay on every reload, so each diagnostic is logged once while it lasts.
    const report = (diagnostics: ReadonlySet<string>, reported: ReadonlySet<string>) => {
      diagnostics.forEach((message) => {
        if (!reported.has(message)) runFork(Effect.logWarning("model route diagnostic", { message }))
      })
      return diagnostics
    }
    let reportedByProviders: ReadonlySet<string> = new Set()
    let reportedByModels: ReadonlySet<string> = new Set()

    yield* ctx.provider.transform((providers) => {
      if (providers.get(ModelRoute.PROVIDER_ID)) return
      const routes = configuredRoutes(loaded.entries)
      if (routes.size === 0) return
      const globalSchedules = weightRulesAcross(configuredSchedules(loaded.entries))
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        providers.list().map((record) => [record.provider.id, record.models] as const),
      )
      const later = builtWithModels(routes)
      const diagnostics = new Set<string>()
      const models = Array.from(routes, ([id, route]) => {
        if (later.has(id)) return undefined
        const { leaves: expanded, nodes, diagnostics: found } = expand(id, routes, definitions)
        found.forEach((message) => diagnostics.add(message))
        if (expanded.length === 0) return undefined
        return routeModel(id, route, expanded, nodes, globalSchedules)
      }).filter((model): model is Model.Info => model !== undefined)
      reportedByProviders = report(diagnostics, reportedByProviders)

      // A pool built with the models below still needs this provider to exist.
      if (models.length === 0 && later.size === 0) return
      providers.add({
        info: {
          ...Provider.Info.empty(ModelRoute.PROVIDER_ID),
          name: "OpenCode routes",
          activation: "enabled",
        },
        models,
      })
    })

    // Pools that use the matching or effort keys are built once provider connections are known, so a pattern
    // adds only models that can be used: a model of a provider that is not connected is never offered here.
    yield* ctx.model.transform((editor) => {
      const routes = configuredRoutes(loaded.entries)
      const later = builtWithModels(routes)
      if (later.size === 0) return
      const globalSchedules = weightRulesAcross(configuredSchedules(loaded.entries))
      const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>(
        editor.provider
          .list()
          .filter((record) => record.provider.id !== ModelRoute.PROVIDER_ID)
          .map((record) => [record.provider.id, record.models] as const),
      )
      const diagnostics = new Set<string>()
      routes.forEach((route, id) => {
        if (!later.has(id)) return
        const {
          leaves,
          nodes,
          diagnostics: found,
        } = expand(id, routes, definitions, (providerID, modelID) => editor.get(providerID, modelID))
        found.forEach((message) => diagnostics.add(message))
        if (leaves.length === 0) return editor.remove(ModelRoute.PROVIDER_ID, id)
        const info = routeModel(id, route, leaves, nodes, globalSchedules)
        editor.update(ModelRoute.PROVIDER_ID, id, (model) => {
          Object.assign(model, info)
        })
      })
      reportedByModels = report(diagnostics, reportedByModels)
    })
  }),
})

/** The model a route is offered as, carrying the definition the resolver reads back. */
function routeModel(
  id: string,
  route: ConfigModelRoutes.Route,
  expanded: readonly SourceModel[],
  nodes: readonly ModelRoute.Node[],
  globalSchedules: readonly ModelRoute.WeightRule[],
) {
  const first = expanded[0].model
  const health = ModelRoute.policy(route.health)
  return Model.Info.make({
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
    variants: routeVariants(expanded, route.levels),
    cost: first.cost,
    status: "active",
    limit: {
      context: Math.min(...expanded.map((target) => target.model.limit.context)),
      output: Math.min(...expanded.map((target) => target.model.limit.output)),
      ...(expanded.every((target) => target.model.limit.input !== undefined)
        ? { input: Math.min(...expanded.map((target) => target.model.limit.input!)) }
        : {}),
    },
  })
}

/** Pools that use a matching or effort key, or nest a pool that does. They are built with the models of
 * connected providers; every other pool is built from the provider definitions, as it always was. A target
 * remap to false is an effort key too: whether the pool offers a level it sits out depends on the variants of
 * its other targets, and variants configured under a provider's models come only with the models. */
function builtWithModels(routes: ReadonlyMap<string, ConfigModelRoutes.Route>) {
  const uses = (id: string, trail: ReadonlySet<string>): boolean => {
    const route = routes.get(id)
    if (!route || trail.has(id)) return false
    if (
      [
        route.include,
        route.exclude,
        route.contains,
        route.notContains,
        route.match,
        route.levels,
        route.variantRules,
      ].some((value) => value !== undefined) ||
      (route.targets ?? []).some((target) => Object.values(targetSpec(target).variants ?? {}).includes(false))
    )
      return true
    const next = new Set(trail).add(id)
    return (route.targets ?? []).some((target) => {
      const ref = targetRef(targetSpec(target).model)
      return (
        ref.providerID === ModelRoute.PROVIDER_ID &&
        uses(ModelRouteMatch.poolsNamed(routes.keys(), ref.id)[0] ?? ref.id, next)
      )
    })
  }
  return new Set([...routes.keys()].filter((id) => uses(id, new Set())))
}

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

/** The schedule rules a route declares for its own targets, in a shape the runtime can judge. An
 * entry with an unreadable window, or with nothing to change, is dropped rather than applied; the
 * config loader has already reported it (scheduleProblems in config/normalize.ts). */
export function routeWeightRules(route: ConfigModelRoutes.Route): ModelRoute.WeightRule[] {
  return (route.schedules ?? []).flatMap((schedule) => {
    if (schedule.factor === undefined && schedule.weight === undefined) return []
    const window = ModelRouteSchedule.parse(schedule.when)
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
 * so one list serves every route and nested route. An entry with nothing to change, or with an
 * unreadable window, is dropped; the config loader has already reported it. */
export function weightRulesAcross(schedules: readonly ConfigModelRoutes.GlobalSchedule[]): ModelRoute.WeightRule[] {
  return schedules.flatMap((schedule) => {
    if (schedule.factor === undefined && schedule.weight === undefined) return []
    const window = ModelRouteSchedule.parse(schedule.when)
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

/** One route's targets and selection tree, with what the pool's author should hear about it. Targets come
 * from `definitions`; `candidate` returns a model as it can be used now, or undefined when its provider is not
 * connected. Models that matching keys add come only through `candidate`, and a target uses it when it has
 * the model, so configured variants count. The route's declared `levels` are applied here: a target that
 * cannot run one of them sits it out. A nested pool's are applied where it is collected, and here its members
 * sit out every other level. A nested pool pinned as `opencode-route/<id>#<level>` runs only at that level, so
 * its remaps and rules decide only whether a member sits the pin out; such a member is left out, and the rest
 * run at the pin at every level of the pools above, which may still sit them out. */
export function expand(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
  candidate: (providerID: Provider.ID, id: Model.ID) => Model.Info | undefined = (providerID, modelID) =>
    definitions.get(providerID)?.get(modelID),
) {
  let catalog: readonly CatalogEntry[] | undefined
  const collected = collect(id, routes, definitions, new Set(), {
    models: () =>
      (catalog ??= [...definitions].flatMap(([providerID, models]) =>
        [...models.keys()].map((modelID) => ({ providerID, id: Model.ID.make(modelID) })),
      )),
    candidate,
    members: new Map(),
  })
  const levels = routes.get(id)?.levels
  // A nested pool's declared levels rule out every other level for its members. They become sit-outs here,
  // where every level this pool can be asked for is known: each one a member has a variant or a remap for,
  // and each one this pool declares.
  const asked = [
    ...new Set([
      ...collected.leaves.flatMap((leaf) => [
        ...leaf.model.variants.map((variant) => String(variant.id)),
        ...Object.keys(leaf.variantMap ?? {}),
      ]),
      ...(levels ?? []),
    ]),
  ]
  const opened = collected.leaves.map((leaf, index) => {
    const allowed = collected.allowed.get(index)
    return allowed === undefined
      ? leaf
      : sitOut(
          leaf,
          asked.filter((level) => !allowed.has(level)),
        )
  })
  if (levels === undefined || opened.length === 0)
    return { leaves: opened, nodes: collected.nodes, diagnostics: collected.diagnostics }
  const leaves = opened.map((leaf) => keptTo(leaf, levels))
  return {
    leaves,
    nodes: collected.nodes,
    diagnostics: [
      ...collected.diagnostics,
      ...[...new Set(levels)]
        .filter((level) => !leaves.some((leaf) => runs(leaf, level)))
        .map((level) => `pool ${id} declares level ${level}, but none of its models can run it, so it is not offered`),
    ],
  }
}

type CatalogEntry = { readonly providerID: Provider.ID; readonly id: Model.ID }

/** What one expansion shares across the pools it reaches. */
type Shared = {
  /** Every defined model in provider order, read only once a pool has matching keys. */
  readonly models: () => readonly CatalogEntry[]
  readonly candidate: (providerID: Provider.ID, id: Model.ID) => Model.Info | undefined
  /** The `provider/model` members of pools named by matching keys, kept only when no cycle was cut while
   * finding them: nothing else makes them depend on which pools were above at the time. Without this a
   * pool naming two pools that each name two more expands the same pools again at every level. */
  readonly members: Map<string, ReadonlySet<string>>
}

/** The members `id` brings, and the tree they form. `enteredAt` are the pins it is entered at: none for the pool
 * being expanded or named by a matching key. */
function collect(
  id: string,
  routes: ReadonlyMap<string, ConfigModelRoutes.Route>,
  definitions: ReadonlyMap<Provider.ID, ReadonlyMap<string, Model.Info>>,
  trail: ReadonlySet<string>,
  shared: Shared,
  enteredAt: readonly Pin[] = [],
) {
  const result: SourceModel[] = []
  const nodes: ModelRoute.Node[] = []
  const seen = new Set<string>()
  // `provider/model` of every target placed so far, whatever its variant: matching keys add a model once.
  const placed = new Set<string>()
  const diagnostics: string[] = []
  // Leaf index to the levels the nested pools above it declare, kept only for leaves under such a pool.
  const allowed = new Map<number, ReadonlySet<string>>()
  // Set when a pool already on the way in is reached again, here or in a pool named below.
  let cut = false

  // A pool named in any case: the one spelled exactly so, else the first that matches ignoring case, with a
  // warning when several do.
  const poolNamed = (routeID: string, name: string) => {
    const named = ModelRouteMatch.poolsNamed(routes.keys(), name)
    if (named.length > 1)
      diagnostics.push(
        `pool ${routeID} names ${name}, which matches ${named.join(", ")} ignoring case; it uses ${named[0]}`,
      )
    return named[0]
  }

  // A term that names a pool, as `<id>` or `opencode-route/<id>` in any case, stands for that pool's models. A
  // pool already on the way in adds nothing for that name, so a pool naming itself, directly or through
  // others, is not an error.
  const reference =
    (routeID: string, within: ReadonlySet<string>) =>
    (text: string): ModelRouteMatch.Predicate | undefined => {
      const prefixed = text.toLowerCase().startsWith(POOL_PREFIX)
      const poolID =
        ModelRouteMatch.poolsNamed(routes.keys(), text).length > 0
          ? poolNamed(routeID, text)
          : prefixed
            ? poolNamed(routeID, text.slice(POOL_PREFIX.length))
            : undefined
      if (poolID === undefined) {
        if (prefixed) diagnostics.push(`pool ${routeID} names ${text}, which is not a pool`)
        return undefined
      }
      if (within.has(poolID)) {
        cut = true
        return () => false
      }
      const members = shared.members.get(poolID) ?? membersOf(poolID, within)
      return (candidate) => members.has(`${candidate.providerID}/${candidate.id}`)
    }
  const membersOf = (poolID: string, within: ReadonlySet<string>) => {
    const named = collect(poolID, routes, definitions, within, shared)
    const members = new Set(named.leaves.map((leaf) => `${leaf.ref.providerID}/${leaf.ref.id}`))
    if (named.cut) cut = true
    else shared.members.set(poolID, members)
    return members
  }

  // Each route becomes a group node with its own selection mode and weights, so a weighted route
  // nested in another is chosen as one unit and then splits among its own members.
  const visit = (routeID: string, trail: ReadonlySet<string>, enclosing: Enclosing): number | undefined => {
    if (trail.has(routeID)) {
      cut = true
      return
    }
    const current = routes.get(routeID)
    if (!current) return
    // The pin this pool runs at, when a pool on the way in was entered at one: the last such pin.
    const pin = enclosing.pins.at(-1)
    // A pool pinned at a level it does not declare offers its members nowhere there.
    if (pin !== undefined && current.levels !== undefined && !current.levels.includes(pin.level)) {
      diagnostics.push(`pool ${routeID} is pinned at level ${pin.level}, which it does not declare, so it adds nothing`)
      return
    }
    const nextTrail = new Set(trail).add(routeID)
    // The config loader skips a pool with a malformed matching key, so this fails only for a pool that
    // never went through it; such a pool contributes nothing rather than part of what it says.
    const compiled = ModelRouteMatch.compile(current, reference(routeID, nextTrail))
    if (Result.isFailure(compiled)) {
      diagnostics.push(
        `pool ${routeID} is skipped: ${compiled.failure.map((problem) => `${problem.path.join(".")}: ${problem.message}`).join("; ")}`,
      )
      return
    }
    const excludes = [...enclosing.excludes, compiled.success.excludes]
    // A remap or rule applies to the levels of the pool that declares it: above any pin, every level the expanded
    // pool is selected at; at a pin, that one level.
    const own = compiled.success.rules
    const rules = pin === undefined ? [...enclosing.rules, ...own] : enclosing.rules
    const pins =
      pin === undefined ? enclosing.pins : [...enclosing.pins.slice(0, -1), { ...pin, rules: [...pin.rules, ...own] }]
    const excluded = (candidate: ModelRouteMatch.Candidate) => excludes.some((test) => test(candidate))
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
      schedules: routeWeightRules(current),
      children: [],
    }
    nodes.push(node)
    const attach = (child: ModelRoute.Node["children"][number], key: string) => {
      node.children.push(child)
      // A nested pool's weight key names a pool, so it matches in any case.
      const weight =
        current.weights?.[key] ??
        (child.node === undefined
          ? undefined
          : Object.entries(current.weights ?? {}).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1])
      node.weights.push(ModelRouteAutonomy.usesRules(current.autonomy) ? (weight ?? 1) : 1)
    }
    const applying = (list: readonly ModelRouteMatch.Rule[], candidate: ModelRouteMatch.Candidate) =>
      list.filter((rule) => rule.applies(candidate)).map((rule) => rule.map)
    // What a member keeps: the rules above any pin, outermost first, then the target's own remap. At a pin the
    // remap applies only to the pin, which a member pinned here runs at whatever the level: its remaps to a
    // variant stay, as they always have, its false entries only decide whether it is left out, and the rules
    // above come last, so a pool above may still sit it out.
    const levelMap = (
      candidate: ModelRouteMatch.Candidate,
      model: Model.Info,
      variants: Readonly<Record<string, string | false>> = {},
    ) =>
      effort(
        model,
        pin === undefined
          ? [...applying(rules, candidate), variants]
          : [
              Object.fromEntries(Object.entries(variants).filter(([, to]) => to !== false)),
              ...applying(rules, candidate),
            ],
      )
    // Whether a member sits out a pin it is under: each pin's rules, and at the last one the target's own remap.
    const sitsOutPin = (
      candidate: ModelRouteMatch.Candidate,
      model: Model.Info,
      variants: Readonly<Record<string, string | false>> = {},
    ) =>
      pins.some(
        (each, index) =>
          effort(model, [...applying(each.rules, candidate), ...(index === pins.length - 1 ? [variants] : [])])[
            each.level
          ] === false,
      )
    const first = result.length
    const place = (
      resolved: Model.Ref,
      model: Model.Info,
      fixedVariant: boolean,
      variantMap: Readonly<Record<string, Model.VariantID | false>>,
      defaultVariantSpec?: string,
    ) => {
      seen.add(`${resolved.providerID}/${resolved.id}${resolved.variant ? `#${resolved.variant}` : ""}`)
      const leafKey = `${resolved.providerID}/${resolved.id}`
      placed.add(leafKey)
      const defaultVariant =
        defaultVariantSpec && model.variants.some((item) => item.id === defaultVariantSpec)
          ? Model.VariantID.make(defaultVariantSpec)
          : undefined
      attach({ leaf: result.length }, leafKey)
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
        fixedVariant,
        ...(defaultVariant ? { defaultVariant } : {}),
        ...(Object.keys(variantMap).length ? { variantMap } : {}),
      })
    }
    for (const target of current.targets ?? []) {
      const spec = targetSpec(target)
      const ref = targetRef(spec.model)
      if (ref.providerID === ModelRoute.PROVIDER_ID) {
        const poolID = poolNamed(routeID, ref.id) ?? ref.id
        // The levels this target object's remap sets to false. The config loader reports any other key it has.
        const off = Object.entries(spec.variants ?? {}).flatMap(([level, to]) => (to === false ? [level] : []))
        // Records each member the nested pool would bring at this pin as left out, named as a later target would
        // repeat it, with its own pin and the pin on the reference, if any.
        const leaveOut = (at: Pin) => {
          const brought = collect(
            poolID,
            routes,
            definitions,
            nextTrail,
            shared,
            ref.variant === undefined
              ? []
              : [{ level: ref.variant, rules: [], leftOut: { targets: new Set(), models: new Set() } }],
          )
          if (brought.cut) cut = true
          brought.leaves.forEach((leaf) => {
            at.leftOut.targets.add(
              `${leaf.ref.providerID}/${leaf.ref.id}${leaf.ref.variant ? `#${leaf.ref.variant}` : ""}`,
            )
            at.leftOut.models.add(`${leaf.ref.providerID}/${leaf.ref.id}`)
          })
        }
        // At a pin, a nested pool that sits the pin out does so as a whole: it is left out, with each member it
        // would bring here.
        if (pin !== undefined && off.includes(pin.level)) {
          leaveOut(pin)
          continue
        }
        const start = result.length
        const child = visit(poolID, nextTrail, {
          excludes,
          rules,
          pins:
            ref.variant === undefined
              ? pins
              : [...pins, { level: ref.variant, rules: [], leftOut: { targets: new Set(), models: new Set() } }],
        })
        // A nested pool reached at a pin it inherits and does not declare adds nothing there (visit says so).
        // Selected at that level without the pin, the pool above would still place its members, each sitting
        // the level out, so they are left out here. A pin written on the reference is a separate member.
        const nested = routes.get(poolID)
        if (
          pin !== undefined &&
          ref.variant === undefined &&
          nested?.levels !== undefined &&
          !nested.levels.includes(pin.level)
        )
          leaveOut(pin)
        // Above any pin, a nested pool written as a target object sits out, as a whole, each level its remap sets
        // to false. At a pin no other level is asked for.
        if (pin === undefined && off.length > 0)
          result.slice(start).forEach((leaf, offset) => {
            result[start + offset] = sitOut(leaf, off)
          })
        if (child !== undefined) attach({ node: child }, `${ModelRoute.PROVIDER_ID}/${poolID}`)
        continue
      }
      if (spec.until !== undefined && Date.now() >= spec.until) continue
      for (const [id, definition] of matchingModels(ref.id, definitions.get(ref.providerID))) {
        const variant = ref.variant ?? pin?.level
        // A member already placed, here or in another pool, is not placed again. This comes first: looking a
        // model up may copy it, and a pool nested along many paths reaches the same models again and again.
        if (seen.has(`${ref.providerID}/${id}${variant ? `#${variant}` : ""}`)) continue
        const named = `${ref.providerID}/${id}${ref.variant ? `#${ref.variant}` : ""}`
        if (pin?.leftOut.targets.has(named)) continue
        // The model as it can be used now, which carries the variants configured for it, else its definition.
        const model = shared.candidate(ref.providerID, id) ?? definition
        if (!model.enabled || excluded({ providerID: ref.providerID, id })) continue
        if (variant && !model.variants.some((item) => item.id === variant)) continue
        if (pin !== undefined && sitsOutPin({ providerID: ref.providerID, id }, model, spec.variants)) {
          pin.leftOut.targets.add(named)
          pin.leftOut.models.add(`${ref.providerID}/${id}`)
          continue
        }
        place(
          Model.Ref.make({ providerID: ref.providerID, id, ...(variant ? { variant } : {}) }),
          model,
          variant !== undefined,
          levelMap({ providerID: ref.providerID, id }, model, spec.variants),
          spec.defaultVariant,
        )
      }
    }
    // Models from include, contains and match follow the targets, in provider order. The cheap tests come
    // first: looking a model up may copy it.
    const selects = compiled.success.selects
    if (selects)
      for (const entry of shared.models()) {
        const key = `${entry.providerID}/${entry.id}`
        if (placed.has(key) || pin?.leftOut.models.has(key) || !selects(entry) || excluded(entry)) continue
        const model = shared.candidate(entry.providerID, entry.id)
        if (!model?.enabled) continue
        if (pin !== undefined && !model.variants.some((item) => item.id === pin.level)) continue
        if (pin !== undefined && sitsOutPin(entry, model)) {
          pin.leftOut.targets.add(key)
          pin.leftOut.models.add(key)
          continue
        }
        place(
          Model.Ref.make({ providerID: entry.providerID, id: entry.id, ...(pin ? { variant: pin.level } : {}) }),
          model,
          pin !== undefined,
          levelMap(entry, model),
        )
      }
    // A nested pool that declares levels keeps its members to them: each sits out the declared levels it
    // cannot run, and expand() sits it out of every other level once all the levels in play are known. A
    // pool entered at a pin is left alone: its members run that pin at every level, and the pin was checked
    // against the declaration above.
    const declared = current.levels
    if (declared !== undefined && routeID !== id && pin === undefined)
      result.slice(first).forEach((leaf, offset) => {
        const index = first + offset
        result[index] = keptTo(leaf, declared)
        allowed.set(index, new Set(declared.filter((level) => allowed.get(index)?.has(level) ?? true)))
      })
    return node.children.length > 0 ? nodeIndex : undefined
  }

  visit(id, trail, { excludes: [], rules: [], pins: enteredAt })
  return { leaves: result, nodes, diagnostics, cut, allowed }
}

/** A target's level remaps: each map in order, a later one overriding an earlier one level by level. A
 * remap to a variant the model does not have leaves that level alone; `false`, sitting it out, always
 * applies. */
function effort(
  model: Model.Info,
  maps: readonly Readonly<Record<string, string | false>>[],
): Record<string, Model.VariantID | false> {
  return Object.fromEntries(
    maps.flatMap((map) =>
      Object.entries(map).flatMap(([from, to]): (readonly [string, Model.VariantID | false])[] => {
        if (to === false) return [[from, false]]
        return model.variants.some((item) => item.id === to) ? [[from, Model.VariantID.make(to)]] : []
      }),
    ),
  )
}

/** A model id, or every model of the provider whose id matches a `*` pattern, in the provider's order. */
function matchingModels(pattern: string, models: ReadonlyMap<string, Model.Info> | undefined) {
  if (!models) return []
  if (!pattern.includes("*")) {
    const model = models.get(pattern)
    return model ? [[Model.ID.make(pattern), model] as const] : []
  }
  const matcher = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  )
  return [...models].filter(([id]) => matcher.test(id)).map(([id, model]) => [Model.ID.make(id), model] as const)
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

/** Whether a target runs `level` when its pool is selected at it: a pinned target always does, at its
 * pin; any other through its remap or its own variant of that name. A remap to `false` sits it out. */
function runs(target: SourceModel, level: string) {
  const mapped = target.variantMap?.[level]
  if (mapped === false) return false
  return target.fixedVariant || mapped !== undefined || target.model.variants.some((item) => item.id === level)
}

/** A member of a pool that declares `levels`, sitting out each declared level it cannot run. */
function keptTo(target: SourceModel, levels: readonly string[]): SourceModel {
  return sitOut(
    target,
    [...new Set(levels)].filter((level) => !runs(target, level)),
  )
}

/** A target with `false` added for each of `levels` it does not already sit out. */
function sitOut(target: SourceModel, levels: readonly string[]): SourceModel {
  const off = levels.filter((level) => target.variantMap?.[level] !== false)
  if (off.length === 0) return target
  return {
    ...target,
    variantMap: { ...target.variantMap, ...Object.fromEntries(off.map((level) => [level, false] as const)) },
  }
}

/** The levels a route offers. Declared `levels` are offered when at least one target runs them. Without
 * them a level is offered when every target runs it or sits it out and at least one runs it, so one
 * target without a level no longer takes it from the whole route once it says it sits that level out.
 * A route with a pinned target offers none, as it always has. */
export function routeVariants(targets: readonly SourceModel[], levels?: readonly string[]) {
  const offer = (list: readonly string[]) => list.map((id) => ({ id: Model.VariantID.make(id) }))
  if (levels !== undefined)
    return offer([...new Set(levels)].filter((level) => targets.some((target) => runs(target, level))))
  if (targets.some((target) => target.fixedVariant)) return []
  const candidates = new Set(
    targets.flatMap((target) => [
      ...target.model.variants.map((variant) => variant.id),
      ...Object.keys(target.variantMap ?? {}),
    ]),
  )
  return offer(
    [...candidates].filter(
      (level) =>
        targets.some((target) => runs(target, level)) &&
        targets.every((target) => runs(target, level) || target.variantMap?.[level] === false),
    ),
  )
}
