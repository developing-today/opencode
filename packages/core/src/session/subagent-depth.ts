export * as SubagentDepth from "./subagent-depth.js"

import { Effect, Schema } from "effect"
import { Config } from "../config.js"
import type { Session } from "../session.js"
import { SessionSchema } from "./schema.js"

export class LimitError extends Schema.TaggedError<LimitError>()("SubagentDepth.LimitError", {
  message: Schema.String,
}) {}

/**
 * Returns the depth of `parent` below its top-level session (0 for a top-level
 * session), failing when launching a subagent from it would exceed
 * `experimental.subagent_depth`. Shared by the subagent tool and by commands
 * that run as subagents, so both enforce the same limit the same way.
 *
 * Parent links can form a cycle (corrupt or imported session data), so the
 * walk visits each session once, and the limit is checked inside the walk:
 * either condition fails promptly instead of looping on the store forever.
 * A limit of 0 disables subagents entirely, so the check also runs for a
 * top-level session, whose depth is 0 and which has no parent to walk to.
 */
export const assertWithinLimit = Effect.fn("SubagentDepth.assertWithinLimit")(function* (
  sessions: Pick<Session.Interface, "get">,
  config: Pick<Config.Interface, "entries">,
  parent: SessionSchema.Info,
) {
  const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 5
  let current = parent
  let depth = 0
  const seen = new Set([parent.id])
  if (depth >= limit)
    return yield* new LimitError({
      message: `Subagent depth limit reached (${limit}). Do this work in the current session; "experimental.subagent_depth" sets the limit.`,
    })
  while (current.parentID) {
    if (seen.has(current.parentID))
      return yield* new LimitError({ message: `Session parent cycle: ${current.parentID}` })
    seen.add(current.parentID)
    depth++
    current = yield* sessions
      .get(current.parentID)
      .pipe(Effect.mapError(() => new LimitError({ message: `Parent session not found: ${current.parentID}` })))
    if (depth >= limit)
      return yield* new LimitError({
        message: `Subagent depth limit reached (${limit}). Do this work in the current session; "experimental.subagent_depth" sets the limit.`,
      })
  }
  return depth
})
