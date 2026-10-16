export * as GitHubShared from "./shared.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Clock, Effect, Exit, Option, Schema, type Scope } from "effect"
import { GitHubClient } from "./client.js"
import type { GitHubFiles } from "./files.js"
import type { GitHubProcess } from "./process.js"
import { GitHubRepo } from "./repo.js"

export const NAMESPACE = "github"
export const SKILL = "github"

/** Everything the tools need from the plugin host, as plain values so tests can supply fakes. */
export interface Deps {
  readonly client: GitHubClient.Client
  readonly run: GitHubProcess.Run
  readonly kv: Context["storage"]
  readonly permission: Pick<Context["permission"], "assert">
  /** Delivers background results into a session. */
  readonly sessions: Pick<Context["session"], "synthetic">
  /** Approves reading local files (uploads) and writing downloads, like the read and write tools do. */
  readonly files: GitHubFiles.Interface
  readonly scope: Scope.Scope
  readonly directory: string
  /** False puts the tools on the provider's native tool list instead of the Code Mode catalog. */
  readonly codemode: boolean
}

export const RepoField = Schema.optionalKey(Schema.String).annotate({
  description: "Repository as owner/name or URL. Defaults to the repository of the session's working directory.",
})

export const NumberRef = Schema.Union([Schema.Int, Schema.String])

export const PRField = Schema.optionalKey(NumberRef).annotate({
  description:
    "Pull request number, #number, owner/repo#number or URL. Defaults to the pull request for the current branch.",
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

// Code Mode scripts call several tools in a row; reading the remotes once per burst saves a handful of git spawns
// per call without hiding a branch switch for long.
const LOCAL_TTL_MS = 5_000
const locals = new Map<
  string,
  { readonly at: number; readonly value: Exit.Exit<GitHubRepo.Local, GitHubClient.Error> }
>()

const localRepo = Effect.fn("GitHubShared.localRepo")(function* (deps: Deps) {
  const now = yield* Clock.currentTimeMillis
  const cached = locals.get(deps.directory)
  if (cached && now - cached.at < LOCAL_TTL_MS) return yield* cached.value
  const value = yield* GitHubRepo.local(deps.run, deps.directory).pipe(Effect.exit)
  locals.set(deps.directory, { at: now, value })
  return yield* value
})

/** Resolves the repository from input or from the working directory's git remotes. */
export const target = Effect.fn("GitHubShared.target")(function* (deps: Deps, repo?: string) {
  if (repo === undefined) {
    const local = yield* localRepo(deps)
    return { repo: local, api: deps.client.forHost(local.host), local } satisfies Target as Target
  }
  const local = Option.getOrUndefined(yield* localRepo(deps).pipe(Effect.option))
  const parsed = GitHubRepo.parse(repo, local?.host ?? defaultHost())
  if (!parsed)
    return yield* new GitHubClient.Error({
      kind: "validation",
      message: `Unrecognized repository: ${repo}. Use owner/name.`,
    })
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
  // A shorthand owner/repo#n reference means the same host as the repository it would otherwise resolve to.
  const host =
    (input.repo === undefined ? undefined : GitHubRepo.parse(input.repo, defaultHost())?.host) ??
    Option.getOrUndefined(yield* localRepo(deps).pipe(Effect.option))?.host ??
    defaultHost()
  const parsed = GitHubRepo.parseNumber(input.ref, host)
  if (!parsed)
    return yield* new GitHubClient.Error({ kind: "validation", message: `Unrecognized reference: ${input.ref}` })
  const resolved = yield* target(
    deps,
    parsed.repo ? `${parsed.repo.host}/${parsed.repo.owner}/${parsed.repo.name}` : input.repo,
  )
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
  // The pull request's head is where the branch is pushed, which can be a fork of the selected repository.
  const branch = resolved.local?.push?.branch ?? resolved.local?.branch
  const headOwner = resolved.local?.push?.owner ?? resolved.repo.owner
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
        query: { head: `${headOwner}:${branch}`, state: "open", per_page: 5 },
      })
      if (open[0]) return open[0].number
      const any = yield* api.json<PullSummary[]>("GET", `/repos/${GitHubRepo.slug(repo)}/pulls`, {
        query: {
          head: `${headOwner}:${branch}`,
          state: "all",
          sort: "updated",
          direction: "desc",
          per_page: 5,
        },
      })
      return any[0]?.number
    })
  const own = yield* find(resolved.repo)
  if (own !== undefined) return { ...resolved, number: own } satisfies PRTarget as PRTarget
  // A branch pushed to a fork usually has its pull request on the parent repository.
  const info = yield* resolved.api.json<{ parent?: { full_name: string } }>(
    "GET",
    `/repos/${GitHubRepo.slug(resolved.repo)}`,
  )
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
export const authorize = (
  deps: Deps,
  context: Tool.Context,
  tool: string,
  repo: GitHubRepo.Ref,
  metadata?: Record<string, unknown>,
) =>
  deps.permission.assert({
    action: `${NAMESPACE}_${tool}`,
    resources: [`${repo.host}/${GitHubRepo.slug(repo)}`],
    save: [`${repo.host}/${GitHubRepo.slug(repo)}`],
    ...(metadata ? { metadata } : {}),
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })

/** Approves reading a local file the tool is about to upload, and returns its absolute path. */
export const readable = (deps: Deps, context: Tool.Context, file: string) =>
  deps.files.authorizeRead(file, context).pipe(Effect.map((target) => target.absolute as string))

/**
 * Approves writing into a local directory the caller chose, with the same external-directory and edit rules as the
 * write tool, and returns its absolute path. Tool-owned scratch directories under the system temp directory skip this.
 */
export const writable = Effect.fn("GitHubShared.writable")(function* (
  deps: Deps,
  context: Tool.Context,
  directory: string,
) {
  const target = yield* deps.files.resolve({ path: directory, kind: "directory" })
  yield* deps.files.authorizeExternal([target], context)
  yield* deps.permission.assert({
    action: "edit",
    resources: [target.resource],
    save: ["*"],
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  return target.absolute as string
})

/** Approves writing one file, as the write tool does before it creates or overwrites a path. */
export const writableFile = Effect.fn("GitHubShared.writableFile")(function* (
  deps: Deps,
  context: Tool.Context,
  file: string,
) {
  const target = yield* deps.files.resolve({ path: file, kind: "file" })
  yield* deps.permission.assert({
    action: "edit",
    resources: [target.resource],
    save: ["*"],
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })
  return target.absolute as string
})

/** Encodes a branch or tag for a URL path, keeping the slashes GitHub expects between ref segments. */
export const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/")

/** Turns any typed failure into a model-facing Tool.Error, appending recovery hints and the fallback skill. */
export function failure(tool: string, error: unknown) {
  if (error instanceof Tool.Error) return error
  if (error instanceof GitHubClient.Error) {
    const fallback =
      error.kind === "validation" || error.kind === "not_found" || error.kind === "conflict"
        ? undefined
        : `If this persists, load the \`${SKILL}\` skill for troubleshooting and gh CLI fallbacks.`
    return new Tool.Error({
      message: [`github.${tool}: ${error.message}`, error.hint, fallback].filter(Boolean).join("\n"),
      metadata: { kind: error.kind, ...(error.status ? { status: error.status } : {}) },
    })
  }
  const message = error instanceof globalThis.Error ? error.message : String(error)
  return new Tool.Error({ message: `github.${tool}: ${message}`, error })
}

export interface Spec<I extends Schema.Codec<unknown, unknown>, O extends Schema.Codec<unknown, unknown>> {
  readonly name: string
  readonly description: string
  readonly input: I
  readonly output: O
  /** Shown in the Code Mode catalog without a search. Reserve for the review loop's entry points. */
  readonly pinned?: boolean
  readonly execute: (
    input: Schema.Schema.Type<I>,
    context: Tool.Context,
  ) => Effect.Effect<Schema.Schema.Type<O>, unknown>
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
