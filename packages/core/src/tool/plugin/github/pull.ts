export * as GitHubPulls from "./pull.js"

import type { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubCopilot } from "./copilot.js"
import { GitHubPreferences } from "./preferences.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api

// ---------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------

const Logins = (description: string) => Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description })

const ReviewerLogins = (description: string) =>
  Logins(`${description} Logins; \`copilot\` requests a Copilot review and \`org/team\` a team review.`)

const MergeMethod = Schema.Literals(["merge", "squash", "rebase"])

const ListItem = Schema.Struct({
  repo: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  draft: Schema.Boolean,
  author: GitHubShared.Author,
  base: Schema.String,
  head: Schema.String,
  labels: Schema.Array(Schema.String),
  review_decision: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.String).annotate({ description: "Rollup state of the head commit's checks." }),
  created_at: Schema.String,
  updated_at: Schema.String,
})

const FileItem = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int,
  previous_path: Schema.optionalKey(Schema.String),
  patch: Schema.optionalKey(Schema.String),
})

// ---------------------------------------------------------------------------------------------------------------
// GitHub data
// ---------------------------------------------------------------------------------------------------------------

interface SearchNode {
  readonly number?: number
  readonly title: string
  readonly url: string
  readonly state: string
  readonly isDraft: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly author: { readonly login: string; readonly __typename?: string } | null
  readonly baseRefName: string
  readonly headRefName: string
  readonly repository: { readonly nameWithOwner: string }
  readonly labels: { readonly nodes: ReadonlyArray<{ readonly name: string }> } | null
  readonly reviewDecision: string | null
  readonly commits: {
    readonly nodes: ReadonlyArray<{
      readonly commit: { readonly statusCheckRollup: { readonly state: string } | null }
    }>
  }
}

const SEARCH_QUERY = `query($q: String!, $first: Int!) {
  search(type: ISSUE, query: $q, first: $first) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url state isDraft createdAt updatedAt author { login __typename }
        baseRefName headRefName repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`

interface RestPull {
  readonly number: number
  readonly node_id: string
  readonly html_url: string
  readonly title: string
  readonly state: string
  readonly draft?: boolean
  readonly merged?: boolean
  readonly base: { readonly ref: string; readonly repo: { readonly full_name: string } | null }
  readonly head: { readonly ref: string; readonly sha: string; readonly repo: { readonly full_name: string } | null }
}

interface RestRepo {
  readonly default_branch: string
  readonly allow_merge_commit?: boolean
  readonly allow_squash_merge?: boolean
  readonly allow_rebase_merge?: boolean
}

interface RestFile {
  readonly filename: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly previous_filename?: string
  readonly patch?: string
}

interface RequestedReviewers {
  readonly requested_reviewers?: ReadonlyArray<{ readonly login: string }>
  readonly requested_teams?: ReadonlyArray<{ readonly slug: string }>
}

const base = (repo: GitHubRepo.Ref) => `/repos/${GitHubRepo.slug(repo)}`

// Branch names keep their slashes; GitHub routes `branches/a/b` and `git/refs/heads/a/b` as one name.
const refPath = (ref: string) => ref.split("/").map(encodeURIComponent).join("/")

const COPILOT_ALIAS = /^@?copilot$/i

/** Splits reviewer names into users and team slugs, mapping the `copilot` alias to Copilot's reviewer login. */
function reviewerBody(logins: ReadonlyArray<string>, teams: ReadonlyArray<string> = []) {
  const users = logins
    .filter((login) => !login.includes("/"))
    .map((login) => (COPILOT_ALIAS.test(login) ? GitHubCopilot.REVIEWER : login))
  const team = [
    ...teams,
    ...logins.filter((login) => login.includes("/")).map((login) => login.slice(login.indexOf("/") + 1)),
  ]
  return { ...(users.length ? { reviewers: users } : {}), ...(team.length ? { team_reviewers: team } : {}) }
}

const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value)

const SCOPED = /(^|\s)-?(repo|org|user):/i

/** Builds a GitHub search query for pull requests from structured filters. */
export function searchQuery(input: {
  readonly repo?: GitHubRepo.Ref
  readonly state?: "open" | "closed" | "merged" | "all"
  readonly author?: string
  readonly assignee?: string
  readonly review_requested?: string
  readonly base?: string
  readonly head?: string
  readonly label?: string | ReadonlyArray<string>
  readonly draft?: boolean
  readonly query?: string
}) {
  const state = input.state ?? "open"
  const labels = input.label === undefined ? [] : typeof input.label === "string" ? [input.label] : input.label
  const scoped = input.query !== undefined && SCOPED.test(input.query)
  return [
    "is:pr",
    state === "open" ? "is:open" : undefined,
    state === "closed" ? "is:closed is:unmerged" : undefined,
    state === "merged" ? "is:merged" : undefined,
    !scoped && input.repo ? `repo:${GitHubRepo.slug(input.repo)}` : undefined,
    input.author ? `author:${input.author}` : undefined,
    input.assignee ? `assignee:${input.assignee}` : undefined,
    input.review_requested ? `review-requested:${input.review_requested}` : undefined,
    input.base ? `base:${quote(input.base)}` : undefined,
    input.head ? `head:${quote(input.head)}` : undefined,
    ...labels.map((label) => `label:${quote(label)}`),
    input.draft === undefined ? undefined : `draft:${input.draft}`,
    input.query?.trim() || undefined,
    input.query?.includes("sort:") ? undefined : "sort:updated-desc",
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ")
}

/** Matches a path against a substring, or a glob where `*` matches any run of characters and `?` one. */
export function pathMatcher(pattern: string | undefined) {
  if (!pattern) return () => true
  if (!/[*?]/.test(pattern)) return (path: string) => path.includes(pattern)
  const source = pattern
    .split("")
    .map((char) => (char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("")
  const regex = new RegExp(`^${source}$`)
  return (path: string) => regex.test(path)
}

/** Runs a follow-up step, turning a failure into a warning so a created pull request is still reported. */
const softly = <A>(warnings: string[], label: string, effect: Effect.Effect<A, GitHubClient.Error>) =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catch((error) =>
      Effect.sync(() => {
        warnings.push(`${label}: ${error.message}`)
        return undefined
      }),
    ),
  )

const getPull = (api: Api, repo: GitHubRepo.Ref, number: number) =>
  api.json<RestPull>("GET", `${base(repo)}/pulls/${number}`)

const stateOf = (pull: RestPull) => (pull.merged ? "merged" : pull.state)

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

export function tools(deps: Deps): Tool.Info[] {
  const prs = GitHubShared.define(deps, {
    name: "prs",
    description: [
      "List or search pull requests with filters (state, author, reviewer, base/head, labels, draft) or raw search qualifiers.",
      "Scoped to the repository unless `query` contains repo:, org: or user:. Newest activity first.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      state: Schema.optionalKey(Schema.Literals(["open", "closed", "merged", "all"])).annotate({
        description: "Default open. closed means closed without merging.",
      }),
      author: Schema.optionalKey(Schema.String),
      assignee: Schema.optionalKey(Schema.String),
      review_requested: Schema.optionalKey(Schema.String).annotate({ description: "Login, or @me." }),
      base: Schema.optionalKey(Schema.String).annotate({ description: "Base branch." }),
      head: Schema.optionalKey(Schema.String).annotate({ description: "Head branch." }),
      label: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
        description: "Label or labels; all must match.",
      }),
      draft: Schema.optionalKey(Schema.Boolean),
      query: Schema.optionalKey(Schema.String).annotate({
        description: "Extra GitHub search qualifiers or free text, e.g. `org:acme in:title flaky` or `status:failure`.",
      }),
      limit: GitHubShared.limit(100, 20),
    }),
    output: Schema.Struct({ total: Schema.Int, query: Schema.String, items: Schema.Array(ListItem) }),
    execute: (input) =>
      Effect.gen(function* () {
        const scoped = input.query !== undefined && SCOPED.test(input.query)
        // An org- or user-wide search needs no repository, so a missing git remote is not an error there.
        const resolved = scoped
          ? Option.getOrUndefined(yield* GitHubShared.target(deps, input.repo).pipe(Effect.option))
          : yield* GitHubShared.target(deps, input.repo)
        const api = resolved?.api ?? deps.client.forHost(process.env.GH_HOST || "github.com")
        const q = searchQuery({ ...input, repo: resolved?.repo })
        const data = yield* api.graphql<{ search: { issueCount: number; nodes: ReadonlyArray<SearchNode> } }>(
          SEARCH_QUERY,
          {
            q,
            first: input.limit ?? 20,
          },
        )
        return {
          total: data.search.issueCount,
          query: q,
          items: data.search.nodes.flatMap((node) =>
            node.number === undefined
              ? []
              : [
                  {
                    repo: node.repository.nameWithOwner,
                    number: node.number,
                    title: node.title,
                    url: node.url,
                    state: node.state,
                    draft: node.isDraft,
                    author: {
                      login: node.author?.login ?? "ghost",
                      kind: GitHubCopilot.authorKind(node.author?.login, node.author?.__typename),
                    },
                    base: node.baseRefName,
                    head: node.headRefName,
                    labels: (node.labels?.nodes ?? []).map((label) => label.name),
                    ...(node.reviewDecision ? { review_decision: node.reviewDecision } : {}),
                    ...(node.commits.nodes[0]?.commit.statusCheckRollup
                      ? { checks: node.commits.nodes[0].commit.statusCheckRollup.state }
                      : {}),
                    created_at: node.createdAt,
                    updated_at: node.updatedAt,
                  },
                ],
          ),
        }
      }),
  })

  const create = GitHubShared.define(deps, {
    name: "pr_create",
    description: [
      "Create a pull request from a pushed branch (default: the current local branch) with optional labels, assignees and reviewers.",
      "Fails with a push hint when the head branch is not on GitHub. Reviewer, label and assignee failures are returned as warnings.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      title: Schema.String,
      body: Schema.optionalKey(Schema.String),
      base: Schema.optionalKey(Schema.String).annotate({ description: "Default: the repository's default branch." }),
      head: Schema.optionalKey(Schema.String).annotate({
        description: "Branch, or owner:branch for a fork. Default: the current local branch.",
      }),
      draft: Schema.optionalKey(Schema.Boolean),
      reviewers: ReviewerLogins("Reviewers to request."),
      team_reviewers: Logins("Team slugs to request."),
      labels: Logins("Labels to add."),
      assignees: Logins("Logins to assign; @me for yourself."),
      maintainer_can_modify: Schema.optionalKey(Schema.Boolean),
    }),
    output: Schema.Struct({
      number: Schema.Int,
      url: Schema.String,
      title: Schema.String,
      base: Schema.String,
      head: Schema.String,
      draft: Schema.Boolean,
      requested_reviewers: Schema.Array(Schema.String),
      labels: Schema.Array(Schema.String),
      warnings: Schema.Array(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const { repo, api } = yield* GitHubShared.target(deps, input.repo)
        const local = Option.getOrUndefined(yield* GitHubRepo.local(deps.process, deps.directory).pipe(Effect.option))
        const head = yield* resolveHead(input.head, repo, local)
        const found = yield* api.request("GET", `/repos/${head.owner}/${head.name}/branches/${refPath(head.branch)}`, {
          allow: [404],
        })
        if (found.status === 404)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            status: 404,
            message: `Branch ${head.branch} does not exist on ${head.owner}/${head.name}.`,
            hint: `Push it first: \`git push -u ${local?.remote ?? "origin"} ${head.branch}\`, then retry.`,
          })
        const baseRef = input.base ?? (yield* api.json<RestRepo>("GET", base(repo))).default_branch
        yield* GitHubShared.authorize(deps, context, "pr_create", repo)
        const created = yield* api.json<RestPull>("POST", `${base(repo)}/pulls`, {
          body: {
            title: input.title,
            head: head.ref,
            base: baseRef,
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.draft !== undefined ? { draft: input.draft } : {}),
            ...(input.maintainer_can_modify !== undefined
              ? { maintainer_can_modify: input.maintainer_can_modify }
              : {}),
          },
        })
        const warnings: string[] = []
        const number = created.number
        const labels = input.labels?.length
          ? yield* softly(
              warnings,
              "labels",
              api.json<ReadonlyArray<{ name: string }>>("POST", `${base(repo)}/issues/${number}/labels`, {
                body: { labels: input.labels },
              }),
            )
          : undefined
        if (input.assignees?.length)
          yield* softly(
            warnings,
            "assignees",
            api.json("POST", `${base(repo)}/issues/${number}/assignees`, { body: { assignees: input.assignees } }),
          )
        const requested = yield* requestReviewers(
          api,
          repo,
          number,
          reviewerBody(input.reviewers ?? [], input.team_reviewers ?? []),
          warnings,
        )
        return {
          number,
          url: created.html_url,
          title: created.title,
          base: created.base.ref,
          head: created.head.ref,
          draft: created.draft ?? false,
          requested_reviewers: requested,
          labels: (labels ?? []).map((label) => label.name),
          warnings,
        }
      }),
  })

  const update = GitHubShared.define(deps, {
    name: "pr_update",
    description:
      "Edit a pull request: title, body, base, open/close, draft/ready, labels, reviewers (`copilot` alias), assignees and milestone.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      title: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
      base: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
      draft: Schema.optionalKey(Schema.Boolean).annotate({
        description: "true converts to draft, false marks ready for review.",
      }),
      add_labels: Logins("Labels to add."),
      remove_labels: Logins("Labels to remove."),
      add_reviewers: ReviewerLogins("Reviewers to request."),
      remove_reviewers: ReviewerLogins("Review requests to withdraw."),
      add_assignees: Logins("Logins to assign."),
      remove_assignees: Logins("Logins to unassign."),
      milestone: Schema.optionalKey(Schema.NullOr(Schema.Int)).annotate({
        description: "Milestone number, or null to clear.",
      }),
    }),
    output: Schema.Struct({
      number: Schema.Int,
      url: Schema.String,
      state: Schema.String,
      draft: Schema.Boolean,
      changed: Schema.Array(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const { api, repo, number } = yield* GitHubShared.pullRequest(deps, input)
        const fields = Object.fromEntries(
          (["title", "body", "base", "state"] as const).flatMap((key) =>
            input[key] === undefined ? [] : [[key, input[key]]],
          ),
        )
        const changed: string[] = []
        const nonEmpty = (list: ReadonlyArray<string> | undefined): list is ReadonlyArray<string> =>
          !!list && list.length > 0
        const pending =
          Object.keys(fields).length > 0 ||
          input.draft !== undefined ||
          input.milestone !== undefined ||
          [
            input.add_labels,
            input.remove_labels,
            input.add_reviewers,
            input.remove_reviewers,
            input.add_assignees,
            input.remove_assignees,
          ].some(nonEmpty)
        if (!pending)
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: "Nothing to update; pass at least one field.",
          })
        yield* GitHubShared.authorize(deps, context, "pr_update", repo)
        const issue = `${base(repo)}/issues/${number}`
        const pulls = `${base(repo)}/pulls/${number}`
        if (Object.keys(fields).length > 0) {
          yield* api.json("PATCH", pulls, { body: fields })
          changed.push(...Object.keys(fields))
        }
        if (input.milestone !== undefined) {
          yield* api.json("PATCH", issue, { body: { milestone: input.milestone } })
          changed.push("milestone")
        }
        if (input.draft !== undefined) {
          const current = yield* getPull(api, repo, number)
          if (current.draft !== input.draft) {
            const mutation = input.draft
              ? "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }"
              : "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }"
            yield* api.graphql(mutation, { id: current.node_id })
            changed.push("draft")
          }
        }
        if (nonEmpty(input.add_labels)) {
          yield* api.json("POST", `${issue}/labels`, { body: { labels: input.add_labels } })
          changed.push("add_labels")
        }
        if (nonEmpty(input.remove_labels)) {
          yield* Effect.forEach(input.remove_labels, (label) =>
            api.request("DELETE", `${issue}/labels/${encodeURIComponent(label)}`, { allow: [404] }),
          )
          changed.push("remove_labels")
        }
        if (nonEmpty(input.add_reviewers)) {
          yield* api.json("POST", `${pulls}/requested_reviewers`, { body: reviewerBody(input.add_reviewers) })
          changed.push("add_reviewers")
        }
        if (nonEmpty(input.remove_reviewers)) {
          yield* api.json("DELETE", `${pulls}/requested_reviewers`, { body: reviewerBody(input.remove_reviewers) })
          changed.push("remove_reviewers")
        }
        if (nonEmpty(input.add_assignees)) {
          yield* api.json("POST", `${issue}/assignees`, { body: { assignees: input.add_assignees } })
          changed.push("add_assignees")
        }
        if (nonEmpty(input.remove_assignees)) {
          yield* api.json("DELETE", `${issue}/assignees`, { body: { assignees: input.remove_assignees } })
          changed.push("remove_assignees")
        }
        const after = yield* getPull(api, repo, number)
        return { number, url: after.html_url, state: stateOf(after), draft: after.draft ?? false, changed }
      }),
  })

  const merge = GitHubShared.define(deps, {
    name: "pr_merge",
    description: [
      "Merge a pull request now, enable auto-merge (auto: true) once requirements pass, or disable auto-merge.",
      "Method defaults to the merge_method preference, else the first the repository allows. expected_head refuses the merge if the head moved.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      method: Schema.optionalKey(MergeMethod),
      auto: Schema.optionalKey(Schema.Boolean).annotate({ description: "Enable auto-merge instead of merging now." }),
      disable_auto: Schema.optionalKey(Schema.Boolean).annotate({ description: "Cancel a pending auto-merge." }),
      subject: Schema.optionalKey(Schema.String).annotate({ description: "Merge commit title." }),
      message: Schema.optionalKey(Schema.String).annotate({ description: "Merge commit body." }),
      expected_head: Schema.optionalKey(Schema.String).annotate({ description: "Head SHA the merge must match." }),
      delete_branch: Schema.optionalKey(Schema.Boolean).annotate({
        description:
          "Delete the head branch after a direct merge, when it lives in the same repository and is not the default branch.",
      }),
    }),
    output: Schema.Struct({
      merged: Schema.Boolean,
      auto_merge: Schema.optionalKey(Schema.String),
      sha: Schema.optionalKey(Schema.String),
      message: Schema.String,
      branch_deleted: Schema.optionalKey(Schema.Boolean),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const { api, repo, number } = yield* GitHubShared.pullRequest(deps, input)
        const current = yield* getPull(api, repo, number)
        yield* GitHubShared.authorize(deps, context, "pr_merge", repo)
        if (input.disable_auto) {
          yield* api.graphql(
            "mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } } }",
            { id: current.node_id },
          )
          return { merged: false, auto_merge: "disabled", message: `Auto-merge disabled for #${number}.` }
        }
        if (current.merged) return { merged: true, message: `#${number} is already merged.` }
        const repoInfo = yield* Effect.cached(api.json<RestRepo>("GET", base(repo)))
        const preferred = input.method ?? (yield* GitHubPreferences.effective(deps.kv, repo)).effective.merge_method
        const method = preferred ?? (yield* allowedMethod(yield* repoInfo))
        if (input.auto) {
          yield* api
            .graphql(
              `mutation($id: ID!, $method: PullRequestMergeMethod!, $headline: String, $body: String, $sha: GitObjectID) {
  enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method, commitHeadline: $headline, commitBody: $body, expectedHeadOid: $sha }) { pullRequest { number } }
}`,
              {
                id: current.node_id,
                method: method.toUpperCase(),
                headline: input.subject ?? null,
                body: input.message ?? null,
                sha: input.expected_head ?? null,
              },
            )
            .pipe(
              Effect.mapError((error) =>
                /clean status|unstable status/i.test(error.message)
                  ? new GitHubClient.Error({
                      ...error,
                      message: error.message,
                      hint: "The pull request can already be merged; call pr_merge without auto to merge it now.",
                    })
                  : new GitHubClient.Error({
                      ...error,
                      message: error.message,
                      hint:
                        error.hint ??
                        "Auto-merge must be allowed in the repository settings and the base branch needs required checks or reviews.",
                    }),
              ),
            )
          return {
            merged: false,
            auto_merge: method,
            message: `Auto-merge (${method}) enabled for #${number}; it merges once requirements pass.`,
          }
        }
        const result = yield* api
          .json<{ sha?: string; merged: boolean; message?: string }>("PUT", `${base(repo)}/pulls/${number}/merge`, {
            body: {
              merge_method: method,
              ...(input.expected_head ? { sha: input.expected_head } : {}),
              ...(input.subject !== undefined ? { commit_title: input.subject } : {}),
              ...(input.message !== undefined ? { commit_message: input.message } : {}),
            },
          })
          .pipe(
            Effect.mapError((error) =>
              error.status === 405 || error.status === 409 || error.status === 422
                ? new GitHubClient.Error({
                    ...error,
                    message: `#${number} cannot be merged: ${error.message}`,
                    hint:
                      error.status === 409 && input.expected_head
                        ? "The head moved since expected_head; inspect the new commits with the `pr` tool before merging again."
                        : "Inspect blockers (checks, reviews, conflicts, merge method) with the `pr` tool, or pass auto: true to merge once requirements pass.",
                  })
                : error,
            ),
          )
        const deleted = input.delete_branch
          ? yield* deleteBranch(api, repo, current, (yield* repoInfo).default_branch)
          : undefined
        return {
          merged: result.merged,
          ...(result.sha ? { sha: result.sha } : {}),
          message: [`Merged #${number} (${method}).`, deleted?.note].filter(Boolean).join(" "),
          ...(deleted ? { branch_deleted: deleted.deleted } : {}),
        }
      }),
  })

  const files = GitHubShared.define(deps, {
    name: "pr_files",
    description:
      "Files changed in a pull request with per-file additions/deletions; optional path filter and clipped patches.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      patch: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Include each file's diff, clipped. Default false.",
      }),
      path: Schema.optionalKey(Schema.String).annotate({
        description: "Substring, or glob where * matches any characters (including /) and ? one, e.g. `*.test.ts`.",
      }),
      limit: GitHubShared.limit(3000, 300),
    }),
    output: Schema.Struct({
      total: Schema.Int.annotate({ description: "Matching files." }),
      additions: Schema.Int,
      deletions: Schema.Int,
      truncated: Schema.Boolean.annotate({ description: "True when more files exist than were read or returned." }),
      files: Schema.Array(FileItem),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const { api, repo, number } = yield* GitHubShared.pullRequest(deps, input)
        const limit = input.limit ?? 300
        // A filter needs every file (GitHub caps the list at 3000) to find matches beyond the first page.
        const cap = input.path ? 3000 : limit
        const all = yield* api.paginate<RestFile>(`${base(repo)}/pulls/${number}/files`, { limit: cap })
        const matches = pathMatcher(input.path)
        const matched = all.filter((file) => matches(file.filename))
        return {
          total: matched.length,
          additions: matched.reduce((sum, file) => sum + file.additions, 0),
          deletions: matched.reduce((sum, file) => sum + file.deletions, 0),
          truncated: all.length >= cap || matched.length > limit,
          files: matched.slice(0, limit).map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.previous_filename ? { previous_path: file.previous_filename } : {}),
            ...(input.patch && file.patch ? { patch: GitHubShared.clip(file.patch, 4000) } : {}),
          })),
        }
      }),
  })

  const review = GitHubShared.define(deps, {
    name: "review",
    description:
      "Submit a pull request review: approve, request_changes or comment, with an optional body and inline comments on diff lines.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      pr: GitHubShared.PRField,
      event: Schema.Literals(["approve", "request_changes", "comment"]),
      body: Schema.optionalKey(Schema.String).annotate({
        description: "Required for request_changes, and for comment without inline comments.",
      }),
      comments: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            path: Schema.String,
            line: Schema.Int.annotate({
              description: "Line in the file on the given side of the diff; the last line for a range.",
            }),
            body: Schema.String,
            side: Schema.optionalKey(Schema.Literals(["LEFT", "RIGHT"])).annotate({
              description: "Default RIGHT (the new code).",
            }),
            start_line: Schema.optionalKey(Schema.Int).annotate({ description: "First line of a multi-line comment." }),
          }),
        ),
      ),
      commit: Schema.optionalKey(Schema.String).annotate({ description: "Commit SHA to review. Default: the head." }),
    }),
    output: Schema.Struct({ id: Schema.Int, state: Schema.String, url: Schema.String }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const hasComments = (input.comments?.length ?? 0) > 0
        if (!input.body && (input.event === "request_changes" || (input.event === "comment" && !hasComments)))
          return yield* new GitHubClient.Error({ kind: "validation", message: `A ${input.event} review needs a body.` })
        const { api, repo, number } = yield* GitHubShared.pullRequest(deps, input)
        yield* GitHubShared.authorize(deps, context, "review", repo)
        const event =
          input.event === "approve" ? "APPROVE" : input.event === "request_changes" ? "REQUEST_CHANGES" : "COMMENT"
        const result = yield* api
          .json<{ id: number; state: string; html_url: string }>("POST", `${base(repo)}/pulls/${number}/reviews`, {
            body: {
              event,
              ...(input.body ? { body: input.body } : {}),
              ...(input.commit ? { commit_id: input.commit } : {}),
              ...(hasComments
                ? {
                    comments: (input.comments ?? []).map((comment) => ({
                      path: comment.path,
                      line: comment.line,
                      body: comment.body,
                      side: comment.side ?? "RIGHT",
                      ...(comment.start_line !== undefined
                        ? { start_line: comment.start_line, start_side: comment.side ?? "RIGHT" }
                        : {}),
                    })),
                  }
                : {}),
            },
          })
          .pipe(
            Effect.mapError((error) =>
              error.status === 422 && /own pull request/i.test(error.message)
                ? new GitHubClient.Error({
                    ...error,
                    message: error.message,
                    hint: "GitHub does not let authors approve or request changes on their own pull request; submit event: comment instead.",
                  })
                : error.status === 422 && hasComments
                  ? new GitHubClient.Error({
                      ...error,
                      message: error.message,
                      hint: "Inline comments must target lines inside the diff; check paths and lines with pr_files (patch: true).",
                    })
                  : error,
            ),
          )
        return { id: result.id, state: result.state, url: result.html_url }
      }),
  })

  return [prs, create, update, merge, files, review]
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** Works out the head branch for a new pull request and where it must exist on GitHub. */
const resolveHead = Effect.fn("GitHubPulls.resolveHead")(function* (
  head: string | undefined,
  repo: GitHubRepo.Ref,
  local: GitHubRepo.Local | undefined,
) {
  if (head !== undefined) {
    const split = head.indexOf(":")
    if (split < 0) return { owner: repo.owner, name: repo.name, branch: head, ref: head }
    const owner = head.slice(0, split)
    // A fork usually keeps the repository's name; the local remote names it exactly when it is that fork.
    const name = local && local.owner.toLowerCase() === owner.toLowerCase() ? local.name : repo.name
    return { owner, name, branch: head.slice(split + 1), ref: head }
  }
  const branch = local?.upstream ?? local?.branch
  if (!local || !branch)
    return yield* new GitHubClient.Error({
      kind: "validation",
      message: "No current local branch to open a pull request from.",
      hint: "Pass `head` explicitly.",
    })
  if (GitHubShared.sameRepo(local, repo)) return { owner: repo.owner, name: repo.name, branch, ref: branch }
  return { owner: local.owner, name: local.name, branch, ref: `${local.owner}:${branch}` }
})

/** Requests reviewers together, then one at a time if that fails, so one bad login does not drop the rest. */
const requestReviewers = Effect.fn("GitHubPulls.requestReviewers")(function* (
  api: Api,
  repo: GitHubRepo.Ref,
  number: number,
  body: { readonly reviewers?: ReadonlyArray<string>; readonly team_reviewers?: ReadonlyArray<string> },
  warnings: string[],
) {
  if (!body.reviewers && !body.team_reviewers) return [] as string[]
  const path = `${base(repo)}/pulls/${number}/requested_reviewers`
  const names = (data: RequestedReviewers | undefined) => [
    ...(data?.requested_reviewers ?? []).map((user) => user.login),
    ...(data?.requested_teams ?? []).map((team) => team.slug),
  ]
  const together = yield* api.json<RequestedReviewers>("POST", path, { body }).pipe(Effect.option)
  if (Option.isSome(together)) return names(together.value)
  const singles = [
    ...(body.reviewers ?? []).map((login) => ({ label: `reviewer ${login}`, body: { reviewers: [login] } })),
    ...(body.team_reviewers ?? []).map((slug) => ({ label: `team ${slug}`, body: { team_reviewers: [slug] } })),
  ]
  const results = yield* Effect.forEach(singles, (single) =>
    softly(warnings, single.label, api.json<RequestedReviewers>("POST", path, { body: single.body })),
  )
  // Each response lists every pending reviewer, so the last success is the complete set.
  return names(results.findLast((result) => result !== undefined))
})

const allowedMethod = (info: RestRepo) => {
  const methods = [
    info.allow_merge_commit === false ? undefined : ("merge" as const),
    info.allow_squash_merge === false ? undefined : ("squash" as const),
    info.allow_rebase_merge === false ? undefined : ("rebase" as const),
  ]
  const first = methods.find((method) => method !== undefined)
  if (first) return Effect.succeed(first)
  return Effect.fail(new GitHubClient.Error({ kind: "validation", message: "The repository allows no merge method." }))
}

const deleteBranch = Effect.fn("GitHubPulls.deleteBranch")(function* (
  api: Api,
  repo: GitHubRepo.Ref,
  pull: RestPull,
  defaultBranch: string,
) {
  if (pull.head.repo?.full_name.toLowerCase() !== GitHubRepo.slug(repo).toLowerCase())
    return { deleted: false, note: "Head branch kept: it lives in another repository." }
  if (pull.head.ref === defaultBranch) return { deleted: false, note: "Head branch kept: it is the default branch." }
  const response = yield* api.request("DELETE", `${base(repo)}/git/refs/heads/${refPath(pull.head.ref)}`, {
    allow: [422],
  })
  // 422 means the reference is already gone, typically deleted by the repository's auto-delete setting.
  return {
    deleted: true,
    note: response.status === 422 ? `Branch ${pull.head.ref} was already deleted.` : `Deleted branch ${pull.head.ref}.`,
  }
})
