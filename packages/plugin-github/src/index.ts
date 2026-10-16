/// <reference path="./markdown.d.ts" />

export * as GitHubTools from "./index.js"

import { Plugin, Skill } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { GitHubActions } from "./actions.js"
import { GitHubClient } from "./client.js"
import { GitHubDiscussions } from "./discussion.js"
import { GitHubExplore } from "./explore.js"
import { GitHubFiles } from "./files.js"
import { GitHubIssues } from "./issue.js"
import { GitHubProcess } from "./process.js"
import { GitHubPulls } from "./pull.js"
import { GitHubReleases } from "./release.js"
import { GitHubReview } from "./review.js"
import { GitHubSettings } from "./settings.js"
import { GitHubShared } from "./shared.js"
import skillContent from "./skill.md" with { type: "text" }

export const ID = "opencode.github"
export const SkillContent = skillContent

const groups = [
  GitHubReview,
  GitHubPulls,
  GitHubIssues,
  GitHubDiscussions,
  GitHubActions,
  GitHubReleases,
  GitHubExplore,
  GitHubSettings,
] as const

/** Every tool, built from host capabilities. Exposed for tests and for hosts that assemble their own dependencies. */
export const tools = (deps: GitHubShared.Deps) => groups.flatMap((group) => group.tools(deps))

/**
 * Disable the plugin like any other with `"plugins": ["-opencode.github"]`, and single tools through permissions,
 * for example `"permission": { "github_pr_merge": "deny" }`. Plugin option `codemode: false` lists the tools on the
 * provider's native tool list as `github_<name>` instead of the Code Mode catalog.
 */
export default Plugin.define({
  id: ID,
  effect: Effect.fn("GitHubTools.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))
    const deps: GitHubShared.Deps = {
      client: GitHubClient.make({ http, run: GitHubProcess.run }),
      run: GitHubProcess.run,
      kv: ctx.storage,
      permission: ctx.permission,
      sessions: ctx.session,
      files: GitHubFiles.make({ location: ctx.location, permission: ctx.permission }),
      scope: yield* Scope.Scope,
      directory: ctx.location.directory,
      codemode: ctx.options.codemode !== false,
    }
    const registered = tools(deps)
    yield* ctx.tool
      .transform((draft) => {
        draft.namespace({
          name: GitHubShared.NAMESPACE,
          description:
            "GitHub through the authenticated gh account: pull request review loops (Copilot and human feedback, replies, resolving, waiting for reviews and CI), pull requests, issues, discussions, Actions, releases, search, repository settings and uploads. Start with context or pr.",
        })
        registered.forEach((tool) => draft.add(tool))
      })
      .pipe(Effect.orDie)
    // Hidden from the skill list; tool failures name it, so it only enters context when something breaks.
    yield* ctx.skill
      .transform((editor) => {
        if (editor.get(Skill.ID.make(GitHubShared.SKILL))) return
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make(GitHubShared.SKILL),
            name: Skill.Name.make("GitHub"),
            description:
              "Troubleshooting and gh CLI fallbacks for the github tools: authentication, scopes, permissions, rate limits, Enterprise hosts, and equivalent gh commands for every tool.",
            autoinvoke: false,
            path: AbsolutePath.make("/builtin/github.md"),
            content: SkillContent,
          }),
        )
      })
      .pipe(Effect.orDie)
  }),
})
