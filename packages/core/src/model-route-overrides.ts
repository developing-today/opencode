export * as ModelRouteOverrides from "./model-route-overrides.js"

import fs from "node:fs"
import path from "node:path"
import { Global } from "@opencode/util/global"
import { ModelRouteAutonomy } from "./model-route-autonomy.js"
import { ModelRouteSchedule } from "./model-route-schedule.js"

/** `avoid` takes a target out of rotation, `prefer` favours it, `allow-over-budget` lets it run past
 * its soft budget. Each one lasts until `until` (or forever when a recurring `schedule` is set),
 * and applies only to the targets it names. */
export type Action = "avoid" | "prefer" | "allow-over-budget"

export interface Override {
  readonly id: string
  readonly action: Action
  /** Provider IDs, compared case-insensitively. Empty means any provider. */
  readonly providers: readonly string[]
  /** Model ID patterns where `*` matches any run of characters. Empty means every model of the
   * named providers; `*` on its own is the explicit "every model" choice. */
  readonly models: readonly string[]
  /** Route IDs the override is limited to. Empty means every route. */
  readonly routes: readonly string[]
  /** Whether it reaches routes set to `fixed`. On by default: a user's word outranks the route's level. */
  readonly fixed: boolean
  /** For `prefer`: the weight multiplier. Above 1 favours the target, below 1 makes it lighter. */
  readonly factor?: number
  /** For `prefer`: sets the target's weight outright instead of scaling it. Takes precedence over
   * `factor` when both are present. */
  readonly weight?: number
  /** Recurring local-time window the override is confined to; unset means it applies whenever `until` allows. */
  readonly schedule?: ModelRouteSchedule.Window
  /** When the override stops applying, epoch milliseconds. Unset with a `schedule` means it recurs
   * indefinitely; unset without one the entry is dropped. */
  readonly until?: number
  readonly text: string
  readonly source: "user" | "interpreter"
  readonly createdAt: number
}

const ACTIONS: readonly Action[] = ["avoid", "prefer", "allow-over-budget"]

let location: string | undefined
let cached: readonly Override[] | undefined

/** Test hook: point the override file somewhere else; no argument restores the default. */
export const setFilePathForTest = (next?: string) => {
  location = next
  cached = undefined
}

export const filePath = () => location ?? path.join(Global.Path.data, "route-overrides.json")

const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : []

const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

export const parse = (item: unknown): Override | undefined => {
  if (!item || typeof item !== "object") return
  const record = item as Record<string, unknown>
  if (typeof record.id !== "string" || !ACTIONS.includes(record.action as Action)) return
  const hasUntil = typeof record.until === "number" && Number.isFinite(record.until)
  const schedule = record.schedule === undefined ? undefined : ModelRouteSchedule.parse(record.schedule)
  if (record.schedule !== undefined && schedule === undefined) return
  if (!hasUntil && schedule === undefined) return
  const providers = strings(record.providers)
  const models = strings(record.models)
  if (providers.length === 0 && models.length === 0) return
  const factor = positive(record.factor)
  const weight = positive(record.weight)
  return {
    id: record.id,
    action: record.action as Action,
    providers,
    models,
    routes: strings(record.routes),
    fixed: record.fixed !== false,
    ...(factor !== undefined ? { factor } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
    ...(hasUntil ? { until: record.until as number } : {}),
    text: typeof record.text === "string" ? record.text : "",
    source: record.source === "interpreter" ? "interpreter" : "user",
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
  }
}

export const readAll = (): readonly Override[] => {
  const file = filePath()
  try {
    if (!fs.existsSync(file)) return []
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    if (!Array.isArray(parsed?.overrides)) return []
    return parsed.overrides.flatMap((item: unknown) => {
      const value = parse(item)
      return value ? [value] : []
    })
  } catch {
    return []
  }
}

export const active = (now = Date.now()): readonly Override[] =>
  readAll().filter((item) => item.schedule !== undefined || item.until === undefined || item.until > now)

export const current = (now = Date.now()): readonly Override[] => {
  if (cached === undefined) cached = active(now)
  return cached
}

export const invalidate = () => {
  cached = undefined
}

export const matchesPattern = (pattern: string, value: string) => {
  if (pattern === "*" || pattern === "") return true
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i")
  return regex.test(value)
}

export interface Scope {
  readonly routeID?: string
  readonly fixed?: boolean
  readonly autonomy?: ModelRouteAutonomy.Level
}

export const applies = (
  item: Override,
  target: { readonly providerID: string; readonly id: string },
  now = Date.now(),
  scope: Scope = {},
) => {
  if (item.schedule !== undefined && !ModelRouteSchedule.active(item.schedule, now)) return false
  if (item.until !== undefined && item.until <= now) return false
  if (scope.fixed && !item.fixed) return false
  if (item.routes.length > 0) {
    if (scope.routeID === undefined) return false
    if (!item.routes.includes(scope.routeID)) return false
  }
  const providerMatches =
    item.providers.length === 0 ||
    item.providers.some((provider) => provider.toLowerCase() === target.providerID.toLowerCase())
  if (!providerMatches) return false
  if (item.models.length === 0) return true
  return item.models.some((pattern) => matchesPattern(pattern, target.id))
}
