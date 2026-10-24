export * as MessagingGraph from "./graph.js"

import { asc, desc, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import { SessionMessageTable, SessionTable } from "../session/sql.js"

type DatabaseService = Database.Interface["db"]

export type Row = typeof SessionTable.$inferSelect

/** The session row, or undefined when it does not exist. */
export const row = Effect.fnUntraced(function* (db: DatabaseService, id: string) {
  return yield* db
    .select()
    .from(SessionTable)
    .where(sql`${SessionTable.id} = ${id}`)
    .get()
    .pipe(Effect.orDie)
})

/** Parent first, then each ancestor up to the root. Excludes the session itself. */
export const ancestors = Effect.fnUntraced(function* (db: DatabaseService, id: string) {
  const ids = yield* db
    .all<{ id: string; depth: number }>(
      sql`WITH RECURSIVE chain(id, parent_id, depth, path) AS (
        SELECT id, parent_id, 0, '/' || id || '/' FROM session_v2 WHERE id = ${id}
        UNION ALL
        SELECT s.id, s.parent_id, c.depth + 1, c.path || s.id || '/' FROM session_v2 s JOIN chain c ON s.id = c.parent_id WHERE c.depth < 256 AND instr(c.path, '/' || s.id || '/') = 0
      ) SELECT id, depth FROM chain WHERE depth > 0 ORDER BY depth`,
    )
    .pipe(Effect.orDie)
  return yield* rows(
    db,
    ids.map((item) => item.id),
  )
})

/** Every subsession below the session, breadth first. Excludes the session itself. */
export const descendants = Effect.fnUntraced(function* (db: DatabaseService, id: string) {
  const ids = yield* db
    .all<{ id: string }>(
      sql`WITH RECURSIVE tree(id, depth, path) AS (
        SELECT id, 0, '/' || id || '/' FROM session_v2 WHERE id = ${id}
        UNION ALL
        SELECT s.id, t.depth + 1, t.path || s.id || '/' FROM session_v2 s JOIN tree t ON s.parent_id = t.id WHERE t.depth < 256 AND instr(t.path, '/' || s.id || '/') = 0
      ) SELECT id FROM tree WHERE depth > 0 ORDER BY depth, id DESC`,
    )
    .pipe(Effect.orDie)
  return yield* rows(
    db,
    ids.map((item) => item.id),
  )
})

export const children = Effect.fnUntraced(function* (db: DatabaseService, id: string) {
  return yield* db
    .select()
    .from(SessionTable)
    .where(sql`${SessionTable.parent_id} = ${id}`)
    .orderBy(asc(SessionTable.time_created), desc(SessionTable.id))
    .all()
    .pipe(Effect.orDie)
})

export const roots = Effect.fnUntraced(function* (db: DatabaseService) {
  return yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(isNull(SessionTable.parent_id))
    .orderBy(desc(SessionTable.time_created), asc(SessionTable.id))
    .all()
    .pipe(Effect.orDie)
})

/** Working directory before the session's first move, or undefined when it never moved. */
export const originalDirectory = Effect.fnUntraced(function* (db: DatabaseService, id: string) {
  const first = yield* db
    .select({
      directory: sql<string | null>`json_extract(${SessionMessageTable.data}, '$.previous.location.directory')`,
    })
    .from(SessionMessageTable)
    .where(
      sql`${SessionMessageTable.session_id} = ${id} AND ${SessionMessageTable.type} = 'location-switched' AND json_extract(${SessionMessageTable.data}, '$.previous') IS NOT NULL`,
    )
    .orderBy(asc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return first?.directory ?? undefined
})

const rows = Effect.fnUntraced(function* (db: DatabaseService, ids: ReadonlyArray<string>) {
  if (ids.length === 0) return []
  const found = yield* Effect.forEach(chunks(ids, 500), (chunk) =>
    db
      .select()
      .from(SessionTable)
      .where(
        sql`${SessionTable.id} IN (${sql.join(
          chunk.map((item) => sql`${item}`),
          sql`, `,
        )})`,
      )
      .all()
      .pipe(Effect.orDie),
  )
  const byID = new Map(found.flat().map((item): [string, Row] => [item.id, item]))
  return ids.flatMap((item) => {
    const value = byID.get(item)
    return value ? [value] : []
  })
})

export function chunks<A>(items: ReadonlyArray<A>, size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  )
}

/**
 * Expands session-set expressions: a session ID, `self`, `parent`, `root` or `user`, optionally
 * suffixed with `+children` (direct subsessions), `+descendants`, `+ancestors` or `+parent`.
 */
export const expand = Effect.fnUntraced(function* (
  db: DatabaseService,
  expressions: ReadonlyArray<string>,
  actor: string | undefined,
) {
  const result = new Set<string>()
  for (const expression of expressions) {
    const [base, ...modifiers] = expression.split("+").map((part) => part.trim())
    const id = yield* alias(db, base, actor)
    if (!id) continue
    result.add(id)
    for (const modifier of modifiers) {
      if (modifier === "children") for (const child of yield* children(db, id)) result.add(child.id)
      if (modifier === "descendants" || modifier === "tree")
        for (const child of yield* descendants(db, id)) result.add(child.id)
      if (modifier === "ancestors") for (const parent of yield* ancestors(db, id)) result.add(parent.id)
      if (modifier === "parent") {
        const parent = (yield* row(db, id))?.parent_id
        if (parent) result.add(parent)
      }
    }
  }
  return result
})

/** Resolves `self`, `parent`, `root` and `user` relative to the actor; other values pass through. */
export const alias = Effect.fnUntraced(function* (db: DatabaseService, value: string, actor: string | undefined) {
  if (value === "user" || value === "*") return value
  if (value === "self" || value === "me" || value === "") return actor
  if (!actor || actor === "user") return value === "parent" || value === "root" ? undefined : value
  if (value === "parent") return (yield* row(db, actor))?.parent_id ?? undefined
  if (value === "root") return (yield* ancestors(db, actor)).at(-1)?.id ?? actor
  return value
})
