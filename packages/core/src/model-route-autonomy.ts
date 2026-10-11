export * as ModelRouteAutonomy from "./model-route-autonomy.js"

/**
 * How much a route may decide for itself. Each level includes everything below it.
 *
 * - `fixed`: the configured order, with failover. No weights, budgets or adjustments.
 * - `rules`: adds selection modes, weights, budgets and provider rate-limit holds.
 * - `adaptive`: adds the scheduled review, which skips or down-weights targets from recent history,
 *   and races the next target once a target keeps giving up.
 * - `predictive`: adds time-of-day and error-text prediction to that review.
 * - `agent`: adds `route_stats` and `route_adjust`, so the model can inspect and steer routing.
 */
export const LEVELS = ["fixed", "rules", "adaptive", "predictive", "agent"] as const
export type Level = (typeof LEVELS)[number]

/** A route with no `autonomy` keeps the behavior it had before levels existed. */
export const rank = (level: Level | undefined) => (level === undefined ? undefined : LEVELS.indexOf(level))

const atLeast = (level: Level | undefined, minimum: Level) => (rank(level) ?? -1) >= LEVELS.indexOf(minimum)

/** Whether a route has reached `minimum`. An unset level keeps every rule on, so it has reached all of them. */
export const reaches = (level: Level | undefined, minimum: Level) => level === undefined || atLeast(level, minimum)

/** Weights, selection modes and budgets apply from `rules` up; an unset level keeps them. */
export const usesRules = (level: Level | undefined) => reaches(level, "rules")

/** A target that keeps giving up is raced by the next target from `adaptive` up; an unset level keeps that. */
export const races = (level: Level | undefined) => reaches(level, "adaptive")

/** The least level a route needs for the review's adjustments to apply to it. With tuning enabled the
 * review reaches every route that uses rules; without it, only routes that ask for `adaptive`. */
export const reviewFloor = (tuningEnabled: boolean): Level => (tuningEnabled ? "rules" : "adaptive")

/** The scheduled review runs when tuning is enabled or a route asks for `adaptive` or more. */
export const reviews = (levels: readonly (Level | undefined)[], tuningEnabled: boolean) =>
  tuningEnabled || levels.some((level) => atLeast(level, "adaptive"))

/** Prediction is generated while some route reaches `predictive`, including routes with no level at all. */
export const predicts = (levels: readonly (Level | undefined)[]) => levels.some((level) => reaches(level, "predictive"))

/** The agent tools are offered when any route is `agent` or has no level at all. */
export const offersTools = (levels: readonly (Level | undefined)[]) =>
  levels.some((level) => level === undefined || level === "agent")
