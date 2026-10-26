export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"
import { ConfigPolicy } from "./policy.js"
import { ConfigModelRoutes } from "./model-routes.js"
import { ConfigAlias } from "./aliases.js"

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  aliases: ConfigAlias.Info.pipe(optional).annotate({
    description: "Configured aliases for providers, models, and effort levels/variants",
  }),
  portable_shell_scanner: Schema.Boolean.pipe(optional).annotate({
    description: "Enable the experimental portable shell permission scanner. Defaults to false.",
  }),
  subagent_depth: NonNegativeInt.pipe(optional).annotate({
    description:
      "Maximum subagent nesting depth below a top-level session. 0 disables subagents and 1 stops subagents from launching their own. Defaults to 5.",
  }),
  shell_timeout: NonNegativeInt.pipe(optional).annotate({
    description:
      "Default timeout in milliseconds for foreground shell commands. 0 disables the timeout. Defaults to 120000.",
  }),
  policies: ConfigPolicy.Info.pipe(Schema.Array, optional).annotate({
    description: "Deprecated: use top-level policies. Ordered policies controlling access to configured resources",
  }),
  model_routes: ConfigModelRoutes.Info.pipe(optional).annotate({
    description: "Named ordered provider/model routes with failure and performance failover",
  }),
  model_route_schedules: Schema.Array(ConfigModelRoutes.GlobalSchedule).pipe(optional).annotate({
    description:
      "Time-bound weight changes across routes: during a local-time window, matching provider/model targets are ranked higher or lower (or given a fixed weight) on every route they appear on. Weights order every selection mode; equal weights keep their configured order.",
  }),
  model_route_tuning: ConfigModelRoutes.Tuning.pipe(optional).annotate({
    description: "Scheduled review of routing history that adjusts model routes automatically",
  }),
  model_route_log: ConfigModelRoutes.Log.pipe(optional).annotate({
    description: "What the routing history records about failed requests",
  }),
}) {}
