import { test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Cause, Effect, Exit, Layer, type Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"

type Body<A, E> = Effect.Effect<A, E, Scope.Scope> | (() => Effect.Effect<A, E, Scope.Scope>)

// Every GitHub call goes through a fake HttpClient; this catches a test that reaches the default client by mistake.
const offline = Object.assign(
  (input: string | URL | Request) =>
    Promise.reject(new Error(`test attempted a network request: ${typeof input === "string" ? input : String(input)}`)),
  { preconnect: fetch.preconnect },
)

const run = <A, E>(body: Body<A, E>, clock: boolean) =>
  Effect.suspend(() => (typeof body === "function" ? body() : body)).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.Fetch, offline as typeof fetch),
    clock ? Effect.provide(Layer.mergeAll(TestClock.layer())) : (effect) => effect,
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isFailure(exit) ? Effect.die(new Error(Cause.pretty(exit.cause))) : Effect.succeed(exit.value),
    ),
    Effect.runPromise,
  )

/** `live` runs on the real clock; `effect` runs on TestClock, so time only moves when the test adjusts it. */
export const it = {
  live: <A, E>(name: string, body: Body<A, E>) => test(name, () => run(body, false)),
  effect: <A, E>(name: string, body: Body<A, E>) => test(name, () => run(body, true)),
}

/** Sets environment variables for the duration of an effect and restores them afterwards. */
export function withEnv<A, E, R>(variables: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(variables).map((key) => [key, process.env[key]]))
      Object.entries(variables).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const makeDir = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-github-test-")))

export const tmpdirScoped = () =>
  Effect.acquireRelease(Effect.promise(makeDir), (dir) =>
    Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
  ).pipe(Effect.map((dir) => ({ path: dir })))

export const withTempDir = <A, E, R>(body: (tmp: { readonly path: string }) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(makeDir),
    (dir) => body({ path: dir }),
    (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
  )

/** A git repository with one empty commit and a local identity, so commits never depend on global config. */
export async function initRepo(directory: string) {
  await $`git init -q ${directory}`.quiet()
  await fs.appendFile(
    path.join(directory, ".git", "config"),
    "[core]\n\tfsmonitor = false\n[commit]\n\tgpgsign = false\n[user]\n\temail = test@opencode.test\n\tname = Test\n",
  )
  await $`git commit -q --allow-empty -m root`.cwd(directory).quiet()
}
