export * as GitHubPreferences from "./preferences.js"

import { Effect, Option, Schema } from "effect"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { GitHubRepo } from "./repo.js"

export const Info = Schema.Struct({
  review_rounds: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }))).annotate({
    description:
      "Copilot review rounds to work through autonomously before handing back to the user. Default 3; later rounds tend to find nits caused by the previous round's fixes.",
  }),
  followup_issues: Schema.optionalKey(Schema.Literals(["auto", "ask", "never"])).annotate({
    description:
      "Whether out-of-scope or minor review findings may be resolved by filing a follow-up issue: auto (just do it), ask (ask the user first), never.",
  }),
  human_reply_prefix: Schema.optionalKey(Schema.String).annotate({
    description:
      "Prefix added to replies on human-written comments so readers know an agent wrote them. Empty to disable.",
  }),
  copilot_auto_request: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether waiting for a Copilot review requests one when none is pending. Default true.",
  }),
  merge_method: Schema.optionalKey(Schema.Literals(["merge", "squash", "rebase"])).annotate({
    description: "Preferred merge method.",
  }),
  wait_timeout_minutes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 720 }))).annotate({
    description: "Default timeout for waits. Default 20.",
  }),
  tools_enabled: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Tools, sections or aliases (wildcards allowed) to show by default, such as administration sections that start hidden.",
  }),
  tools_disabled: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Tools, sections or aliases (wildcards allowed) to hide by default.",
  }),
  notes: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Free-form standing instructions, such as 'treat security nits as non-blocking'.",
  }),
})
export type Info = typeof Info.Type

/**
 * The same preferences without their documentation, for outputs. The preferences tool's input documents each one,
 * so outputs that carry them (context, preferences) do not repeat the descriptions in every Code Mode signature.
 */
export const Values = Schema.Struct({
  review_rounds: Schema.optionalKey(Schema.Number),
  followup_issues: Schema.optionalKey(Schema.Literals(["auto", "ask", "never"])),
  human_reply_prefix: Schema.optionalKey(Schema.String),
  copilot_auto_request: Schema.optionalKey(Schema.Boolean),
  merge_method: Schema.optionalKey(Schema.Literals(["merge", "squash", "rebase"])),
  wait_timeout_minutes: Schema.optionalKey(Schema.Number),
  tools_enabled: Schema.optionalKey(Schema.Array(Schema.String)),
  tools_disabled: Schema.optionalKey(Schema.Array(Schema.String)),
  notes: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const DEFAULTS = {
  review_rounds: 3,
  human_reply_prefix: "> *Automated response from an AI coding agent*",
  copilot_auto_request: true,
  wait_timeout_minutes: 20,
} as const

const decode = Schema.decodeUnknownOption(Info)
const PREFIX = "github.preferences/"

export const globalKey = `${PREFIX}global`
export const repoKey = (repo: GitHubRepo.Ref) => `${PREFIX}repo/${repo.host}/${repo.owner}/${repo.name}`.toLowerCase()

export const read = Effect.fn("GitHubPreferences.read")(function* (kv: StorageDomain, key: string) {
  const value = yield* kv.get(key)
  return Option.getOrElse(decode(value), (): Info => ({}))
})

/** Merges stored preferences: repository over global over discovered defaults over built-in defaults. */
export const effective = Effect.fn("GitHubPreferences.effective")(function* (
  kv: StorageDomain,
  repo: GitHubRepo.Ref | undefined,
  discovered: Info = {},
) {
  const global = yield* read(kv, globalKey)
  const local = repo ? yield* read(kv, repoKey(repo)) : ({} as Info)
  return {
    stored: { global, repo: local },
    effective: { ...DEFAULTS, ...discovered, ...global, ...local } as Info & typeof DEFAULTS,
  }
})

export const write = Effect.fn("GitHubPreferences.write")(function* (
  kv: StorageDomain,
  key: string,
  set: Info,
  clear: ReadonlyArray<string>,
) {
  const current = yield* read(kv, key)
  const next = Object.fromEntries(
    Object.entries({ ...current, ...set }).filter(([name, value]) => value !== undefined && !clear.includes(name)),
  )
  if (Object.keys(next).length === 0) yield* kv.remove(key)
  else yield* kv.set(key, next as Schema.Json)
  return next as Info
})
