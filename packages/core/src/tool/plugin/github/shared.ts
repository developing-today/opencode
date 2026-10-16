export * as GitHubShared from "./shared.js"

import { ToolFailure } from "@opencode/ai"
import type { Tool } from "@opencode/schema/tool"
import type { AppProcess } from "@opencode/util/process"
import { Effect, Option, Schema, type Scope } from "effect"
import type { Job } from "../../../job.js"
import type { KV } from "../../../kv.js"
import type { Permission } from "../../../permission.js"
import type { Session } from "../../../session.js"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"

export const NAMESPACE = "github"
export const SKILL = "github"

export interface Deps {
  readonly client: GitHubClient.Client
  readonly process: AppProcess.Interface
  readonly kv: KV.Interface
  readonly permission: Pick<Permission.Interface, "assert">
  /** Delivers background results into a session. */
  readonly sessions: Pick<Session.Interface, "synthetic">
  readonly jobs: Job.Interface
  readonly scope: Scope.Scope
  readonly directory: string
  /** False when OPENCODE_GITHUB_TOOLS=native registers the tools on the provider's native tool list. */
  readonly codemode: boolean
}

export const RepoField = Schema.optionalKey(Schema.String).annotate({
  description: "Repository as owner/name or URL. Defaults to the repository of the session's working directory.",
})

export const NumberRef = Schema.Union([Schema.Int, Schema.String])

export const PRField = Schema.optionalKey(NumberRef).annotate({
  description: "Pull request number, #number, owner/repo#number or URL. Defaults to the pull request for the current branch.",
})

export const limit = (maximum: number, fallback: number) =>
  Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum }))).annotate({
    description: `Maximum results. Default ${fallback}, maximum ${maximum}.`,
  })

export const Author = Schema.Struct({
  login: Schema.String,
  kind: Schema.Literals(["copilot", "bot", "human"]),
})

export interface Target {
  readonly repo: GitHubRepo.Ref
  readonly api: GitHubClient.Api
  readonly local?: GitHubRepo.Local
}

export interface PRTarget extends Target {
  readonly number: number
}

const defaultHost = () => process.env.GH_HOST || "github.com"

/** Resolves the repository from input or from the working directory's git remotes. */
export const target = Effect.fn("GitHubShared.target")(function* (deps: Deps, repo?: string) {
  if (repo === undefined) {
    const local = yield* GitHubRepo.local(deps.process, deps.directory)
    return { repo: local, api: deps.client.forHost(local.host), local } satisfies Target as Target
  }
  const local = Option.getOrUndefined(yield* GitHubRepo.local(deps.process, deps.directory).pipe(Effect.option))
  const parsed = GitHubRepo.parse(repo, local?.host ?? defaultHost())
  if (!parsed)
    return yield* new GitHubClient.Error({ kind: "validation", message: `Unrecognized repository: ${repo}. Use owner/name.` })
  const same = local && sameRepo(local, parsed)
  return { repo: parsed, api: deps.client.forHost(parsed.host), ...(same ? { local } : {}) } satisfies Target as Target
})

export const sameRepo = (left: GitHubRepo.Ref, right: GitHubRepo.Ref) =>
  left.host === right.host &&
  left.owner.toLowerCase() === right.owner.toLowerCase() &&
  left.name.toLowerCase() === right.name.toLowerCase()

/** Resolves an issue, pull request or discussion number; a URL or owner/repo#n reference overrides `repo`. */
export const numbered = Effect.fn("GitHubShared.numbered")(function* (
  deps: Deps,
  input: { readonly repo?: string; readonly ref: string | number },
) {
  const parsed = GitHubRepo.parseNumber(input.ref)
  if (!parsed) return yield* new GitHubClient.Error({ kind: "validation", message: `Unrecognized reference: ${input.ref}` })
  const resolved = yield* target(deps, parsed.repo ? `${parsed.repo.host}/${parsed.repo.owner}/${parsed.repo.name}` : input.repo)
  return { ...resolved, number: parsed.number } satisfies PRTarget as PRTarget
})

interface PullSummary {
  readonly number: number
  readonly state: string
  readonly head: { readonly ref: string; readonly repo: { readonly owner: { readonly login: string } } | null }
}

/** Resolves a pull request from input, or finds the one for the working directory's current branch. */
export const pullRequest = Effect.fn("GitHubShared.pullRequest")(function* (
  deps: Deps,
  input: { readonly repo?: string; readonly pr?: string | number },
) {
  if (input.pr !== undefined) return yield* numbered(deps, { repo: input.repo, ref: input.pr })
  const resolved = yield* target(deps, input.repo)
  const branch = resolved.local?.upstream ?? resolved.local?.branch
  if (!branch)
    return yield* new GitHubClient.Error({
      kind: "validation",
      message: "No current branch to find a pull request for.",
      hint: "Pass `pr` explicitly.",
    })
  const find = (repo: GitHubRepo.Ref) =>
    Effect.gen(function* () {
      const api = deps.client.forHost(repo.host)
      const open = yield* api.json<PullSummary[]>("GET", `/repos/${GitHubRepo.slug(repo)}/pulls`, {
        query: { head: `${resolved.repo.owner}:${branch}`, state: "open", per_page: 5 },
      })
      if (open[0]) return open[0].number
      const any = yield* api.json<PullSummary[]>("GET", `/repos/${GitHubRepo.slug(repo)}/pulls`, {
        query: { head: `${resolved.repo.owner}:${branch}`, state: "all", sort: "updated", direction: "desc", per_page: 5 },
      })
      return any[0]?.number
    })
  const own = yield* find(resolved.repo)
  if (own !== undefined) return { ...resolved, number: own } satisfies PRTarget as PRTarget
  // A branch pushed to a fork usually has its pull request on the parent repository.
  const info = yield* resolved.api.json<{ parent?: { full_name: string } }>("GET", `/repos/${GitHubRepo.slug(resolved.repo)}`)
  const parent = info.parent ? GitHubRepo.parse(info.parent.full_name, resolved.repo.host) : undefined
  const upstream = parent ? yield* find(parent) : undefined
  if (parent && upstream !== undefined)
    return {
      repo: parent,
      api: deps.client.forHost(parent.host),
      ...(resolved.local ? { local: resolved.local } : {}),
      number: upstream,
    } satisfies PRTarget as PRTarget
  return yield* new GitHubClient.Error({
    kind: "not_found",
    message: `No pull request found for branch ${branch} in ${GitHubRepo.slug(resolved.repo)}${parent ? ` or ${GitHubRepo.slug(parent)}` : ""}.`,
    hint: "Push the branch and create one with pr_create, or pass `pr` explicitly.",
  })
})

/** Asks permission for a GitHub write. Defaults allow; configure `github_<tool>` permissions to require approval. */
export const authorize = (deps: Deps, context: Tool.Context, tool: string, repo: GitHubRepo.Ref, metadata?: Record<string, unknown>) =>
  deps.permission.assert({
    action: `${NAMESPACE}_${tool}`,
    resources: [`${repo.host}/${GitHubRepo.slug(repo)}`],
    save: [`${repo.host}/${GitHubRepo.slug(repo)}`],
    ...(metadata ? { metadata } : {}),
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })

/** Turns any typed failure into a model-facing ToolFailure, appending recovery hints and the fallback skill. */
export function failure(tool: string, error: unknown) {
  if (error instanceof ToolFailure) return error
  if (error instanceof GitHubClient.Error) {
    const fallback =
      error.kind === "validation" || error.kind === "not_found" || error.kind === "conflict"
        ? undefined
        : `If this persists, load the \`${SKILL}\` skill for troubleshooting and gh CLI fallbacks.`
    return new ToolFailure({
      message: [`github.${tool}: ${error.message}`, error.hint, fallback].filter(Boolean).join("\n"),
      metadata: { kind: error.kind, ...(error.status ? { status: error.status } : {}) },
    })
  }
  const message = error instanceof globalThis.Error ? error.message : String(error)
  return new ToolFailure({ message: `github.${tool}: ${message}`, error })
}

export interface Spec<I extends Schema.Codec<unknown, unknown>, O extends Schema.Codec<unknown, unknown>> {
  readonly name: string
  readonly description: string
  readonly input: I
  readonly output: O
  /** Shown in the Code Mode catalog without a search. Reserve for the review loop's entry points. */
  readonly pinned?: boolean
  readonly execute: (input: Schema.Schema.Type<I>, context: Tool.Context) => Effect.Effect<Schema.Schema.Type<O>, unknown>
}

export function define<I extends Schema.Codec<unknown, unknown>, O extends Schema.Codec<unknown, unknown>>(
  deps: Deps,
  spec: Spec<I, O>,
): Tool.Info<I, O> {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    options: deps.codemode
      ? { namespace: NAMESPACE, codemode: true, ...(spec.pinned ? { pinned: true } : {}) }
      : { namespace: NAMESPACE, codemode: false },
    execute: (input, context) =>
      spec.execute(input as Schema.Schema.Type<I>, context).pipe(
        Effect.map((output) => ({ output })),
        Effect.mapError((error) => failure(spec.name, error)),
      ),
  } as Tool.Info<I, O>
}

/** Trims long text for model output while saying how much was cut. */
export function clip(text: string | null | undefined, max = 4000) {
  if (!text) return ""
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [${text.length - max} more characters]`
}

export const decodeBase64 = (value: string) => Buffer.from(value, "base64")
