/// <reference path="../../../markdown.d.ts" />

export * as GitHubTools from "./index.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { AppProcess } from "@opencode/util/process"
import { Effect, Scope } from "effect"
import { HttpClient } from "effect/http"
import { FileAccess } from "../../../file-access.js"
import { Job } from "../../../job.js"
import { KV } from "../../../kv.js"
import { Permission } from "../../../permission.js"
import { AbsolutePath } from "../../../schema.js"
import { Session } from "../../../session.js"
import { Skill } from "../../../skill.js"
import { GitHubActions } from "./actions.js"
import { GitHubClient } from "./client.js"
import { GitHubDiscussions } from "./discussion.js"
import { GitHubExplore } from "./explore.js"
import { GitHubIssues } from "./issue.js"
import { GitHubPulls } from "./pull.js"
import { GitHubReleases } from "./release.js"
import { GitHubReview } from "./review.js"
import { GitHubShared } from "./shared.js"
import skillContent from "./skill.md" with { type: "text" }

export const SkillContent = skillContent

/**
 * `OPENCODE_GITHUB_TOOLS` selects how the tools register: `codemode` (default) puts them in the Code Mode catalog,
 * `native` puts them on the provider's tool list for sessions without Code Mode, and `off` skips them.
 */
export function mode(value = process.env.OPENCODE_GITHUB_TOOLS) {
  const normalized = value?.trim().toLowerCase()
  if (normalized === "off" || normalized === "false" || normalized === "0") return "off" as const
  if (normalized === "native") return "native" as const
  return "codemode" as const
}

export const Plugin = {
  id: "opencode.tools.github",
  effect: Effect.fn("GitHubTools.Plugin")(function* (ctx: Context) {
    const selected = mode()
    if (selected === "off") return
    const deps: GitHubShared.Deps = {
      client: GitHubClient.make({ http: yield* HttpClient.HttpClient, process: yield* AppProcess.Service }),
      process: yield* AppProcess.Service,
      kv: yield* KV.Service,
      permission: yield* Permission.Service,
      sessions: yield* Session.Service,
      files: yield* FileAccess.Service,
      jobs: yield* Job.Service,
      scope: yield* Scope.Scope,
      directory: ctx.location.directory,
      codemode: selected === "codemode",
    }
    const tools = [
      ...GitHubReview.tools(deps),
      ...GitHubPulls.tools(deps),
      ...GitHubIssues.tools(deps),
      ...GitHubDiscussions.tools(deps),
      ...GitHubActions.tools(deps),
      ...GitHubReleases.tools(deps),
      ...GitHubExplore.tools(deps),
    ]
    yield* ctx.tool
      .transform((draft) => {
        draft.namespace({
          name: GitHubShared.NAMESPACE,
          description:
            "GitHub through the authenticated gh account: pull request review loops (Copilot and human feedback, replies, resolving, waiting for reviews and CI), pull requests, issues, discussions, Actions, releases, search, repository settings and uploads. Start with context or pr.",
        })
        for (const tool of tools) draft.add(tool)
      })
      .pipe(Effect.orDie)
    // Hidden from the skill list; tool failures name it so it only enters context when something breaks.
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
}
