import { expect } from "bun:test"
import { Effect, Exit, Ref } from "effect"
import { LockTimeoutError, SqlError, UnknownError } from "effect/sql/SqlError"
import { Sqlite } from "@opencode/core/database/sqlite"
import { it } from "./lib/effect"

const locked = () =>
  new SqlError({ reason: new LockTimeoutError({ cause: new Error("database is locked"), operation: "execute" }) })

const notLock = () =>
  new SqlError({ reason: new UnknownError({ cause: new Error("file is not a database"), operation: "execute" }) })

it.live("retries a locked statement until it succeeds", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const opened = yield* Sqlite.retryBusy(
      Ref.updateAndGet(attempts, (count) => count + 1).pipe(
        Effect.flatMap((attempt) => (attempt <= 3 ? Effect.fail(locked()) : Effect.succeed("opened"))),
      ),
    )

    expect(opened).toBe("opened")
    expect(yield* Ref.get(attempts)).toBe(4)
  }),
)

it.live("does not retry an error that is not a lock", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const exit = yield* Sqlite.retryBusy(
      Ref.update(attempts, (count) => count + 1).pipe(Effect.andThen(Effect.fail(notLock()))),
    ).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    expect(yield* Ref.get(attempts)).toBe(1)
  }),
)
