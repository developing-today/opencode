export * as SessionAffinity from "./affinity.js"

import { Effect } from "effect"
import type { SessionSchema } from "./schema.js"

// TODO: Should the `model.request` hook expose affinity so plugins stop deriving it from `ctx.session.get`?
/** The Session ID that groups model requests for provider cache routing: children share the parent's, forks the fork source's. */
export const get = (session: Pick<SessionSchema.Info, "id" | "parentID" | "fork">) =>
  session.parentID ?? session.fork?.sessionID ?? session.id

/**
 * Resolved top-level Session IDs, keyed by Session ID. A Session's parent and
 * fork links are written once when it is created and never change, so a
 * resolved root stays valid for the life of the cache. Keep one cache per
 * service or plugin instance so each Session's root is computed once instead
 * of adding a Session read to every model request.
 */
export type RootCache = Map<SessionSchema.ID, SessionSchema.ID>

export const rootCache = (): RootCache => new Map()

/**
 * The top-level Session ID grouping a Session tree's model requests: follows
 * parent and fork links (the links `get` follows one level) until a Session
 * with neither. A link whose Session cannot be read is itself the root, which
 * matches `get` for a dangling parent. Parent links can form a cycle (corrupt
 * or imported Session data), so the walk visits each Session once and stops
 * at the repeated link instead of looping on the store forever.
 */
export const resolveRoot = Effect.fn("SessionAffinity.resolveRoot")(function* (
  cache: RootCache,
  session: SessionSchema.Info,
  lookup: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info | undefined>,
) {
  const cached = cache.get(session.id)
  if (cached) return cached
  const chain = [session]
  const seen = new Set([session.id])
  let current = session
  let root = session.id
  while (true) {
    const link = current.parentID ?? current.fork?.sessionID
    if (!link) {
      root = current.id
      break
    }
    const known = cache.get(link)
    if (known) {
      root = known
      break
    }
    if (seen.has(link)) {
      root = link
      break
    }
    const parent = yield* lookup(link)
    if (!parent) {
      root = link
      break
    }
    chain.push(parent)
    seen.add(parent.id)
    current = parent
  }
  for (const node of chain) cache.set(node.id, root)
  cache.set(root, root)
  return root
})
