import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import path from "node:path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { HttpServer } from "effect/http"
import { SqlError } from "effect/sql/SqlError"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

const options = (database: string) => ({
  hostname: "127.0.0.1",
  port: 0,
  password: "secret",
  app: { version: "test-version" },
  database: { path: database },
  models: { fetch: false },
})

it.live(
  "a database another connection holds during boot opens once the lock clears",
  () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("opencode-server-busy-")
      const file = path.join(tmp.path, "opencode.db")
      const setup = new Database(file)
      setup.run("PRAGMA journal_mode = WAL")
      setup.close()
      // An exclusive lock makes a new connection's first statement fail as busy, like a predecessor still closing.
      const holder = new Database(file)
      holder.run("PRAGMA locking_mode = EXCLUSIVE")
      holder.query("select count(*) from sqlite_master").get()

      const starting = yield* Effect.forkChild(ServerProcess.start<never, never>(options(file)))
      yield* Effect.sleep("1 second")
      holder.close()
      const server = yield* Fiber.join(starting)

      const info = yield* Effect.promise(() =>
        fetch(new URL("/api/info", HttpServer.formatAddress(server.address)), {
          headers: { authorization: `Basic ${btoa("opencode:secret")}` },
        }),
      )
      expect(info.status).toBe(200)
    }),
  30_000,
)

it.live("a database file that is not a database fails boot with its own error", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-server-corrupt-")
    const file = path.join(tmp.path, "opencode.db")
    yield* Effect.promise(() => Bun.write(file, "x".repeat(4096)))

    const exit = yield* ServerProcess.start<never, never>(options(file)).pipe(Effect.exit)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const error = Cause.squash(exit.cause)
    expect(error).toBeInstanceOf(SqlError)
    expect((error as SqlError).reason._tag).toBe("UnknownError")
  }),
)
