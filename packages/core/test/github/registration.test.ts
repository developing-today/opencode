import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Image } from "@opencode/core/image"
import { Tool } from "@opencode/core/tool"
import { GitHubActions } from "@opencode/core/tool/plugin/github/actions"
import { GitHubDiscussions } from "@opencode/core/tool/plugin/github/discussion"
import { GitHubExplore } from "@opencode/core/tool/plugin/github/explore"
import { GitHubTools } from "@opencode/core/tool/plugin/github/index"
import { GitHubIssues } from "@opencode/core/tool/plugin/github/issue"
import { GitHubPulls } from "@opencode/core/tool/plugin/github/pull"
import { GitHubReleases } from "@opencode/core/tool/plugin/github/release"
import { GitHubReview } from "@opencode/core/tool/plugin/github/review"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { imagePassthrough } from "../lib/image"
import { testEffect } from "../lib/effect"
import { codeModeListings, toolDefinitions } from "../lib/tool"
import { fakeGitHub, makeDeps } from "./fixture"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, AppProcess.node]), [Image.node.replace(imagePassthrough)]),
)

const groups = [GitHubReview, GitHubPulls, GitHubIssues, GitHubDiscussions, GitHubActions, GitHubReleases, GitHubExplore]

describe("github tool registration", () => {
  it.live("every tool registers in the Code Mode catalog under github with a valid definition", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const { deps } = yield* makeDeps({ http: fakeGitHub({}).http })
      const tools = groups.flatMap((group) => group.tools(deps))
      yield* registry.transform((editor) => tools.forEach((tool) => editor.add(tool)))
      const snapshot = yield* registry.snapshot()
      const listed = codeModeListings(snapshot.codeModeCatalog ?? { tools: [] }).map((entry) => entry.path)
      expect(listed.toSorted()).toEqual(tools.map((tool) => `github.${tool.name}`).toSorted())
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
      // Code Mode tools stay off the provider's native list.
      expect((yield* toolDefinitions(registry)).some((definition) => definition.name.startsWith("github_"))).toBe(false)
    }),
  )

  it.live("native mode puts the tools on the provider tool list as github_<name>", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const made = yield* makeDeps({ http: fakeGitHub({}).http })
      const tools = GitHubReview.tools({ ...made.deps, codemode: false })
      yield* registry.transform((editor) => tools.forEach((tool) => editor.add(tool)))
      const names = (yield* toolDefinitions(registry)).map((definition) => definition.name)
      expect(names).toContain("github_feedback")
      expect(names).toContain("github_respond")
    }),
  )

  it.live("OPENCODE_GITHUB_TOOLS selects the registration mode", () =>
    Effect.sync(() => {
      expect(GitHubTools.mode(undefined)).toBe("codemode")
      expect(GitHubTools.mode("native")).toBe("native")
      expect(GitHubTools.mode(" OFF ")).toBe("off")
      expect(GitHubTools.mode("0")).toBe("off")
      expect(GitHubTools.mode("anything")).toBe("codemode")
    }),
  )
})

