import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { Skill } from "@opencode/core/skill"
import { Tool } from "@opencode/core/tool"
import { GitHubTools } from "@opencode/core/tool/plugin/github/index"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { codeModeListings, executeTool, toolIdentity } from "../lib/tool"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(Layer.provideMerge(AppNodeBuilder.build(Job.node), PluginTestLayer))

it.live("the plugin registers Code Mode tools, a hidden fallback skill, and persists preferences through execute", () =>
  withEnv({ OPENCODE_GITHUB_TOOLS: undefined }, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const sessions = yield* Session.Service
      const location = yield* Location.Service
      const skills = yield* Skill.Service
      const registry = yield* Tool.Service
      yield* GitHubTools.Plugin.effect(yield* PluginHost.make(plugins))

      const snapshot = yield* registry.snapshot()
      const listed = codeModeListings(snapshot.codeModeCatalog ?? { tools: [] }).map((entry) => entry.path)
      expect(listed).toContain("github.feedback")
      expect(listed).toContain("github.wait")
      expect(listed).toContain("github.respond")

      const skill = (yield* skills.list()).find((entry) => entry.id === "github")
      expect(skill?.autoinvoke).toBe(false)
      expect(skill?.content).toContain("gh equivalents")

      const session = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
      const execute = (code: string) =>
        executeTool(registry, {
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: `call-${code.length}`, name: "execute", input: { code } },
        }).pipe(
          Effect.map((result) => JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "null")),
        )

      expect(
        yield* execute(
          `return await tools.github.preferences({ scope: "global", set: { review_rounds: 5, notes: ["skip style nits"] } })`,
        ),
      ).toMatchObject({ global: { review_rounds: 5, notes: ["skip style nits"] }, effective: { review_rounds: 5 } })
      expect(
        yield* execute(`return await tools.github.preferences({ scope: "global", clear: ["notes"] })`),
      ).toMatchObject({
        global: { review_rounds: 5 },
      })
      expect((yield* execute(`return await tools.github.preferences({})`)).global).toEqual({ review_rounds: 5 })
    }),
  ),
)
