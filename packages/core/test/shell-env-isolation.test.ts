import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { SessionSchema } from "@opencode/core/session/schema"
import { Shell } from "@opencode/core/shell"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { it } from "./lib/effect"

// Regression coverage for #20: a plugin that rewrites TMPDIR in
// `shell.hook("create.before")` (the durable-tmpdir plugin) must affect only the
// spawned child shell — never the server's own process.env, the stored session
// environment, or later shells once the hook is gone.
if (process.platform !== "win32") {
  it.live("create.before env mutations reach the child shell only", () =>
    Effect.gen(function* () {
      // Real directories: the test fixtures create their own temp dirs under
      // whatever TMPDIR the process reports, so the sentinel values must exist.
      const base = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-env-isolation-")))
      const original = path.join(base, "server")
      const sessionValue = path.join(base, "session")
      const mutated = path.join(base, "hook")
      yield* Effect.promise(() => Promise.all([original, sessionValue, mutated].map((dir) => fs.mkdir(dir))))
      const previous = process.env.TMPDIR
      process.env.TMPDIR = original
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => fs.rm(base, { recursive: true, force: true })).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.TMPDIR
              else process.env.TMPDIR = previous
            }),
          ),
          Effect.orDie,
        ),
      )

      yield* Effect.gen(function* () {
        const shell = yield* Shell.Service
        const hooks = yield* PluginHooks.Service
        const environments = yield* SessionEnvironment.Service
        const sessionID = SessionSchema.ID.make("ses_env_isolation")
        yield* environments.set(sessionID, { TMPDIR: sessionValue })

        const registration = yield* hooks.register("shell", "create.before", (invocation) =>
          Effect.sync(() => {
            invocation.env.TMPDIR = mutated
          }),
        )

        // Process-env base: the child sees the hook value, the server process does not.
        const first = yield* shell.create({ shell: "/bin/sh", command: `printf %s "$TMPDIR"`, timeout: 0 })
        expect((yield* shell.result(first)).capture?.output).toBe(mutated)
        expect(process.env.TMPDIR).toBe(original)

        // Session-env base: the child sees the hook value, the stored session env is unchanged.
        const second = yield* shell.create({
          shell: "/bin/sh",
          command: `printf %s "$TMPDIR"`,
          timeout: 0,
          metadata: { sessionID },
        })
        expect((yield* shell.result(second)).capture?.output).toBe(mutated)
        expect(yield* environments.get(sessionID)).toEqual({ TMPDIR: sessionValue })
        expect(process.env.TMPDIR).toBe(original)

        // Once the hook is disposed, later shells see the unmutated base env again.
        yield* registration.dispose
        const third = yield* shell.create({ shell: "/bin/sh", command: `printf %s "$TMPDIR"`, timeout: 0 })
        expect((yield* shell.result(third)).capture?.output).toBe(original)
        expect(process.env.TMPDIR).toBe(original)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Shell.node, PluginHooks.node, SessionEnvironment.node]), [
            Location.node.replace(tempLocationLayer),
            Global.node.replace(tempGlobalLayer),
            Config.node.replace(Config.testLayer()),
            Environment.node.replace(hostEnvironmentLayer),
          ]),
        ),
      )
    }),
  )
}
