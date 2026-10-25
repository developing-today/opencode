import { Schema } from "effect"
import { Model } from "./model.js"
import { optional } from "./schema.js"

/**
 * An explicit per-agent override inside a session's subagent policy. Its `model`
 * replaces the agent definition's default outright; its lists intersect the
 * definition's lists unless `force` is set, in which case they replace them.
 * Ancestor session policies still apply and cannot be forced past.
 */
export interface SessionAgentOverride extends Schema.Schema.Type<typeof SessionAgentOverride> {}
export const SessionAgentOverride = Schema.Struct({
  model: Model.Ref.pipe(optional),
  models: Schema.Array(Model.Selector).pipe(optional),
  excludedModels: Schema.Array(Model.Selector).pipe(optional),
  subagentModels: Schema.Array(Model.Selector).pipe(optional),
  subagentExcludedModels: Schema.Array(Model.Selector).pipe(optional),
  force: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "Session.AgentOverride" })

/**
 * A session's declaration of which models its descendants may run. Descendants
 * can only narrow it: every ancestor's policy filters the effective set by
 * intersection, and excluded selectors union down the tree.
 */
export interface SessionSubagentPolicy extends Schema.Schema.Type<typeof SessionSubagentPolicy> {}
export const SessionSubagentPolicy = Schema.Struct({
  models: Schema.Array(Model.Selector).pipe(optional),
  excludedModels: Schema.Array(Model.Selector).pipe(optional),
  agentOverrides: Schema.Record(Schema.String, SessionAgentOverride).pipe(optional),
}).annotate({ identifier: "Session.SubagentPolicy" })
