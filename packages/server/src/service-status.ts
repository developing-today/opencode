export * as Status from "./service-status"

import { Duration, Effect, Latch, Ref } from "effect"

/**
 * How the serve process answers requests in each state (`dispatch` in process.ts):
 *
 * - `starting`: `GET /api/info` answers at once with 503 and `Retry-After` until ready. Any other request waits up
 *   to `startupWait` for readiness and is then served normally, with no 503. If startup is still running when the
 *   wait ends, the request gets 503 `service_starting` with `Retry-After`. A failed start or a shutdown ends the
 *   wait at once, and a client that disconnects cancels its own wait.
 * - `ready`: serves every request.
 * - `stopping`: keeps serving the application it already has, so a predecessor still answers the connections it
 *   accepted while its successor takes over. Without an application it answers 503 `service_stopping`.
 * - `failed`: answers 503 `service_failed` at once, until shutdown.
 */
export type State =
  | { readonly type: "starting" }
  | { readonly type: "ready" }
  | { readonly type: "stopping" }
  | { readonly type: "failed" }

// Many times a successor's measured startup (about 1 to 1.5 seconds unloaded, see serve-handover.test.ts), so a loaded
// or cold start still finishes in time. Short enough that a stuck startup does not hold a client for minutes.
export const startupWait = Duration.seconds(25)

export interface Interface {
  readonly current: Effect.Effect<State>
  // Returns once startup is no longer pending or `startupWait` has passed. Callers read `current` again afterwards.
  readonly awaitStartup: Effect.Effect<void>
  readonly ready: Effect.Effect<void>
  readonly fail: Effect.Effect<void>
  readonly beginStopping: Effect.Effect<void>
}

export const make = Effect.fnUntraced(function* (options: { readonly initial?: State } = {}) {
  const current = yield* Ref.make(options.initial ?? ({ type: "starting" } satisfies State))
  // Opened by the first transition out of `starting` and left open, so a waiter that arrives late still passes.
  const startupEnded = yield* Latch.make()
  const leaveStarting = startupEnded.open.pipe(Effect.asVoid)
  const beginStopping = Ref.update(current, (status) =>
    status.type === "stopping" ? status : ({ type: "stopping" } satisfies State),
  ).pipe(Effect.andThen(leaveStarting))

  return {
    current: Ref.get(current),
    awaitStartup: Effect.gen(function* () {
      const status = yield* Ref.get(current)
      if (status.type !== "starting") return
      yield* startupEnded.await.pipe(Effect.timeoutOption(startupWait))
    }),
    ready: Ref.update(current, (status) =>
      status.type === "starting" ? ({ type: "ready" } satisfies State) : status,
    ).pipe(Effect.andThen(leaveStarting)),
    fail: Ref.update(current, (status) =>
      status.type === "starting" ? ({ type: "failed" } satisfies State) : status,
    ).pipe(Effect.andThen(leaveStarting)),
    beginStopping,
  } satisfies Interface
})
