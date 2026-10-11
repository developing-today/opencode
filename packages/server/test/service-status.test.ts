import { expect } from "bun:test"
import { Effect, Fiber, Ref } from "effect"
import { TestClock } from "effect/testing"
import { it } from "../../core/test/lib/effect"
import { Status } from "../src/service-status"

it.effect("moves from starting to ready", () =>
  Effect.gen(function* () {
    const status = yield* Status.make()
    expect(yield* status.current).toEqual({ type: "starting" })
    yield* status.ready
    expect(yield* status.current).toEqual({ type: "ready" })
  }),
)

it.effect("keeps a startup failure until shutdown", () =>
  Effect.gen(function* () {
    const status = yield* Status.make()
    yield* status.fail
    yield* status.ready
    yield* status.fail
    expect(yield* status.current).toEqual({ type: "failed" })
  }),
)

it.effect("keeps stopping after shutdown begins", () =>
  Effect.gen(function* () {
    const status = yield* Status.make()

    yield* status.beginStopping
    expect(yield* status.current).toEqual({ type: "stopping" })
    yield* status.beginStopping
    expect(yield* status.current).toEqual({ type: "stopping" })
  }),
)

it.effect("holds a request during startup until the server is ready", () =>
  Effect.gen(function* () {
    const status = yield* Status.make()
    const served = yield* Ref.make(false)
    const waiting = yield* Effect.forkChild(status.awaitStartup.pipe(Effect.andThen(Ref.set(served, true))))
    yield* TestClock.adjust("1 second")
    expect(yield* Ref.get(served)).toBe(false)

    yield* status.ready
    yield* Fiber.join(waiting)
    expect(yield* Ref.get(served)).toBe(true)
  }),
)

it.effect("ends the wait at once when startup fails or shutdown begins", () =>
  Effect.gen(function* () {
    const failing = yield* Status.make()
    const stopping = yield* Status.make()
    const failed = yield* Effect.forkChild(failing.awaitStartup)
    const stopped = yield* Effect.forkChild(stopping.awaitStartup)

    yield* failing.fail
    yield* stopping.beginStopping
    yield* Fiber.join(failed)
    yield* Fiber.join(stopped)
  }),
)

it.effect("stops waiting after the startup wait while still starting", () =>
  Effect.gen(function* () {
    const status = yield* Status.make()
    const waiting = yield* Effect.forkChild(status.awaitStartup)

    yield* TestClock.adjust(Status.startupWait)
    yield* Fiber.join(waiting)
    expect(yield* status.current).toEqual({ type: "starting" })
  }),
)

it.effect("does not wait once startup has settled", () =>
  Effect.gen(function* () {
    const status = yield* Status.make()
    yield* status.ready
    yield* status.awaitStartup
    expect(yield* status.current).toEqual({ type: "ready" })
  }),
)
