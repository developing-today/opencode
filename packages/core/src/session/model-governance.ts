export * as ModelGovernance from "./model-governance.js"

import { Effect, Schema } from "effect"
import type { Entry } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { Agent } from "@opencode/schema/agent"
import { Config } from "../config.js"
import type { Session } from "../session.js"
import { SessionSchema } from "./schema.js"

export class DeniedError extends Schema.TaggedError<DeniedError>()("ModelGovernance.DeniedError", {
  message: Schema.String,
}) {}

/** The model-relevant slice of an agent definition, resolved from config entries. */
export type Definition = {
  model?: Model.Ref
  models?: readonly Model.Selector[]
  excludedModels?: readonly Model.Selector[]
  subagentModels?: readonly Model.Selector[]
  subagentExcludedModels?: readonly Model.Selector[]
  maxDepth?: number
}

/**
 * Agent definitions from config entries, merged in entry order the way the
 * config agent plugin applies them: later documents override earlier fields.
 * Agents defined only by plugins carry no definition here and are treated as
 * unrestricted by the definition layer; session policy still governs them.
 */
export function agentDefinitions(entries: readonly Entry[]): Map<string, Definition> {
  const definitions = new Map<string, Definition>()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [id, item] of Object.entries(entry.info.agents ?? {})) {
      const current = definitions.get(id) ?? {}
      if (item.model !== undefined)
        current.model = {
          id: Model.ID.make(item.model.model),
          providerID: Provider.ID.make(item.model.providerID),
          ...(item.model.variant === undefined ? {} : { variant: Model.VariantID.make(item.model.variant) }),
        }
      if (item.models !== undefined) current.models = item.models
      if (item.excluded_models !== undefined) current.excludedModels = item.excluded_models
      if (item.subagent_models !== undefined) current.subagentModels = item.subagent_models
      if (item.subagent_excluded_models !== undefined) current.subagentExcludedModels = item.subagent_excluded_models
      if (item.max_depth !== undefined) current.maxDepth = item.max_depth
      definitions.set(id, current)
    }
  }
  return definitions
}

type Tagged = { selector: Model.Selector; layer: string }

const refString = (ref: Model.Ref) => `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ""}`

function intersectSelectors(a: readonly Model.Selector[], b: readonly Model.Selector[]): Model.Selector[] {
  const result: Model.Selector[] = []
  for (const left of a) {
    for (const right of b) {
      const narrower = Model.Selector.intersect(left, right)
      if (narrower !== undefined && !result.includes(narrower)) result.push(narrower)
    }
  }
  return result
}

function intersectAllowed(
  current: Tagged[] | undefined,
  list: readonly Model.Selector[] | undefined,
  layer: string,
): Tagged[] | undefined {
  if (list === undefined) return current
  if (current === undefined) return list.map((selector) => ({ selector, layer }))
  const result: Tagged[] = []
  for (const existing of current) {
    for (const selector of list) {
      const narrower = Model.Selector.intersect(existing.selector, selector)
      if (narrower === undefined) continue
      if (result.some((item) => item.selector === narrower)) continue
      // The narrower selector is the one that binds, so it keeps its layer.
      result.push({ selector: narrower, layer: narrower === existing.selector ? existing.layer : layer })
    }
  }
  return result
}

function unionExcluded(
  current: Tagged[],
  list: readonly Model.Selector[] | undefined,
  layer: string,
): Tagged[] {
  if (list === undefined) return current
  const result = [...current]
  for (const selector of list) {
    if (!result.some((item) => item.selector === selector)) result.push({ selector, layer })
  }
  return result
}

function applyOverride(
  definition: { allowed: readonly Model.Selector[] | undefined; excluded: readonly Model.Selector[] | undefined },
  override: SessionSchema.AgentOverride | undefined,
) {
  if (override === undefined) return definition
  // An override that addresses only the subagent lists leaves the agent's own lists
  // alone: its force must not clear a list group it never mentions (#508). An override
  // carrying no list fields at all (e.g. the Task tool's `{ model, force }`) still
  // forces the agent's own lists, as its documentation promises.
  if (
    override.models === undefined &&
    override.excludedModels === undefined &&
    (override.subagentModels !== undefined || override.subagentExcludedModels !== undefined)
  )
    return definition
  if (override.force === true) return { allowed: override.models, excluded: override.excludedModels }
  return {
    allowed:
      override.models === undefined
        ? definition.allowed
        : definition.allowed === undefined
          ? override.models
          : intersectSelectors(definition.allowed, override.models),
    excluded: [...(definition.excluded ?? []), ...(override.excludedModels ?? [])],
  }
}

/**
 * The same override composition for an agent's subagent lists: an override's
 * `subagentModels` / `subagentExcludedModels` narrow (or, with `force`,
 * replace) the lists it overrides, exactly as its `models` / `excludedModels`
 * do for the agent's own lists in `applyOverride`.
 */
function applySubagentOverride(
  definition: { allowed: readonly Model.Selector[] | undefined; excluded: readonly Model.Selector[] | undefined },
  override: SessionSchema.AgentOverride | undefined,
) {
  if (override === undefined) return definition
  // Symmetrically, an override carrying no subagent lists at all leaves the launching
  // agent's subagent lists in force — its force is aimed at the child agent's own
  // lists and must not clear a group it never mentions (#508).
  if (override.subagentModels === undefined && override.subagentExcludedModels === undefined) return definition
  return applyOverride(definition, {
    models: override.subagentModels,
    excludedModels: override.subagentExcludedModels,
    force: override.force,
  })
}

/** Route targets from config entries, following nested route references. */
function routeTargets(entries: readonly Entry[], routeID: string, seen: Set<string>): Model.Ref[] {
  if (seen.has(routeID)) return []
  seen.add(routeID)
  const routes = Config.latest(entries, "experimental")?.model_routes
  const route = routes?.[routeID]
  if (route === undefined) return []
  return route.targets.flatMap((target) => {
    const selection = "providerID" in target ? target : target.model
    const ref = {
      id: Model.ID.make(selection.model),
      providerID: Provider.ID.make(selection.providerID),
      ...(selection.variant === undefined ? {} : { variant: Model.VariantID.make(selection.variant) }),
    } satisfies Model.Ref
    return ref.providerID === "opencode-route" ? routeTargets(entries, ref.id, seen) : [ref]
  })
}

export type Input = {
  /** The launching session; its ancestry supplies the hard subtree filter. */
  parent: SessionSchema.Info
  /** The child session's agent, when known. */
  agent?: Agent.ID
  /** The explicit model choice for the child, when one was made. */
  model?: Model.Ref
  /** The per-call override from the launching tool, when one was supplied. */
  override?: SessionSchema.AgentOverride
}

/**
 * Answers whether a child of `input.parent`, running `input.agent`, may run its
 * would-be model: the explicit choice, then the (possibly overridden) agent
 * default, then the parent's model. Restrictions compose by intersection down
 * the tree — ancestor session policies are hard, the launching agent's subagent
 * lists bind its direct children, and the child agent's own lists apply with
 * explicit overrides (policy `agentOverrides`, then the per-call override).
 * An override's subagent lists compose into the launching agent's layer with
 * the same force semantics as its own lists compose into the child's layer.
 * A route-named model passes only when every target of the route passes.
 */
export const assertAllowed = Effect.fn("ModelGovernance.assertAllowed")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries">,
  input: Input,
) {
  const entries = yield* config.entries()
  const definitions = agentDefinitions(entries)

  const chain: SessionSchema.Info[] = [input.parent]
  const seen = new Set([input.parent.id])
  let current = input.parent
  while (current.parentID) {
    if (seen.has(current.parentID))
      return yield* new DeniedError({ message: `Session parent cycle: ${current.parentID}` })
    seen.add(current.parentID)
    const parentID = current.parentID
    current = yield* sessions
      .get(parentID)
      .pipe(Effect.mapError(() => new DeniedError({ message: `Parent session not found: ${parentID}` })))
    chain.push(current)
  }

  // Layer 1: ancestor session policies, hard at every level.
  let allowed: Tagged[] | undefined
  let excluded: Tagged[] = []
  // Every layer that narrowed the allowed set, kept so a denial can name what
  // bound it even when the intersection leaves nothing allowed.
  const restrictionLayers: string[] = []
  const narrow = (list: readonly Model.Selector[] | undefined, layer: string) => {
    if (list !== undefined && !restrictionLayers.includes(layer)) restrictionLayers.push(layer)
    allowed = intersectAllowed(allowed, list, layer)
  }
  for (const session of chain) {
    const layer = `session policy of session ${session.id}`
    narrow(session.subagentPolicy?.models, layer)
    excluded = unionExcluded(excluded, session.subagentPolicy?.excludedModels, layer)
  }

  // The explicit overrides for this launch, applied to both the launching
  // agent's subagent lists (layer 2) and the child agent's own lists (layer 3).
  const policyOverride =
    input.agent === undefined ? undefined : input.parent.subagentPolicy?.agentOverrides?.[input.agent]

  // Layer 2: the launching agent's subagent lists bind the children it
  // launches, with the launch's explicit overrides composed into them — an
  // override's subagent lists bind even when the launching agent has no
  // config definition to override.
  const launcher = input.parent.agent === undefined ? undefined : definitions.get(input.parent.agent)
  if (input.parent.agent !== undefined) {
    const layer = `subagent models of agent ${input.parent.agent}`
    const overridden = applySubagentOverride(
      applySubagentOverride(
        { allowed: launcher?.subagentModels, excluded: launcher?.subagentExcludedModels },
        policyOverride,
      ),
      input.override,
    )
    narrow(overridden.allowed, layer)
    excluded = unionExcluded(excluded, overridden.excluded, layer)
  }

  // Layer 3: the child agent's own lists, with explicit overrides applied.
  const definition = input.agent === undefined ? undefined : definitions.get(input.agent)
  const overridden = applyOverride(
    applyOverride({ allowed: definition?.models, excluded: definition?.excludedModels }, policyOverride),
    input.override,
  )
  if (input.agent !== undefined) {
    const layer = `models of agent ${input.agent}`
    narrow(overridden.allowed, layer)
    excluded = unionExcluded(excluded, overridden.excluded, layer)
  }

  const model =
    input.model ??
    input.override?.model ??
    policyOverride?.model ??
    definition?.model ??
    input.parent.model
  if (model === undefined) return

  const targets = model.providerID === "opencode-route" ? routeTargets(entries, model.id, new Set()) : undefined
  const checked = targets !== undefined && targets.length > 0 ? targets : [model]
  for (const target of checked) {
    const deniedBy = excluded.find((item) => Model.Selector.matches(item.selector, target))
    if (deniedBy !== undefined)
      return yield* new DeniedError({
        message: `Model ${refString(target)}${targets !== undefined ? ` (target of route ${refString(model)})` : ""} is not allowed for this subagent: it is excluded by ${deniedBy.layer} (${deniedBy.selector}). Allowed models: ${allowed === undefined ? "any model not excluded" : allowed.map((item) => item.selector).join(", ") || "none"}.`,
      })
    if (allowed !== undefined && !allowed.some((item) => Model.Selector.matches(item.selector, target)))
      return yield* new DeniedError({
        message: `Model ${refString(target)}${targets !== undefined ? ` (target of route ${refString(model)})` : ""} is not allowed for this subagent. Allowed models: ${allowed.map((item) => item.selector).join(", ") || "none"}. Bound by ${(allowed.length > 0 ? [...new Set(allowed.map((item) => item.layer))] : restrictionLayers).join(", ")}.`,
      })
  }
})
