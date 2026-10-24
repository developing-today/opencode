import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GitHubPreferences } from "../src/preferences.js"
import { GitHubPulls } from "../src/pull.js"
import { it, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Reply, type Route } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }
const HEAD = "a".repeat(40)

const setup = (routes: Record<string, Reply | Route>) =>
  Effect.gen(function* () {
    const github = fakeGitHub(routes)
    const made = yield* makeDeps({ http: github.http })
    const tools = GitHubPulls.tools(made.deps)
    return { github, ...made, tool: (name: string) => find(tools, name) }
  })

const writes = (requests: ReadonlyArray<{ method: string; path: string; body: unknown }>) =>
  requests.filter((request) => request.method !== "GET").map((request) => [request.method, request.path, request.body])

const restPull = (input: { draft?: boolean; headRepo?: string; merged?: boolean } = {}) => ({
  number: 7,
  node_id: "PR_7",
  html_url: "https://github.com/acme/widgets/pull/7",
  title: "Add pagination",
  state: "open",
  draft: input.draft ?? false,
  merged: input.merged ?? false,
  base: { ref: "main", repo: { full_name: "acme/widgets" } },
  head: { ref: "feature/pages", sha: HEAD, repo: { full_name: input.headRepo ?? "acme/widgets" } },
})

describe("GitHubPulls helpers", () => {
  test("searchQuery adds qualifiers and scopes to the repository", () => {
    expect(
      GitHubPulls.searchQuery({
        repo: { host: "github.com", owner: "acme", name: "widgets" },
        state: "closed",
        author: "octo",
        review_requested: "@me",
        base: "main",
        label: ["bug", "needs review"],
        draft: false,
      }),
    ).toBe(
      'is:pr is:closed is:unmerged repo:acme/widgets author:octo review-requested:@me base:main label:bug label:"needs review" draft:false sort:updated-desc',
    )
  })

  test("pathMatcher treats plain text as a substring and * ? as wildcards", () => {
    const glob = GitHubPulls.pathMatcher("*.test.ts")
    expect(["src/a.test.ts", "src/a.ts", "a.test.tsx"].filter(glob)).toEqual(["src/a.test.ts"])
    expect(["src/a.ts", "lib/b.ts"].filter(GitHubPulls.pathMatcher("src/"))).toEqual(["src/a.ts"])
    expect(["v1.ts", "v12.ts"].filter(GitHubPulls.pathMatcher("v?.ts"))).toEqual(["v1.ts"])
  })
})

describe("github pull request tools", () => {
  it.live("prs searches with repo scoping and maps results", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GRAPHQL search(type: ISSUE": {
            body: {
              search: {
                issueCount: 41,
                nodes: [
                  {
                    number: 7,
                    title: "Add pagination",
                    url: "https://github.com/acme/widgets/pull/7",
                    state: "OPEN",
                    isDraft: true,
                    createdAt: "2026-01-01T00:00:00Z",
                    updatedAt: "2026-01-02T00:00:00Z",
                    author: null,
                    baseRefName: "main",
                    headRefName: "feature/pages",
                    repository: { nameWithOwner: "acme/widgets" },
                    labels: { nodes: [{ name: "bug" }] },
                    reviewDecision: "REVIEW_REQUIRED",
                    commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
                  },
                  {},
                ],
              },
            },
          },
        })
        const result = yield* run<object, unknown>(tool("prs"), {
          repo: "acme/widgets",
          author: "octo",
          label: "bug",
          limit: 5,
        })
        expect(result).toEqual({
          total: 41,
          query: "is:pr is:open repo:acme/widgets author:octo label:bug sort:updated-desc",
          items: [
            {
              repo: "acme/widgets",
              number: 7,
              title: "Add pagination",
              url: "https://github.com/acme/widgets/pull/7",
              state: "OPEN",
              draft: true,
              author: { login: "ghost", kind: "bot" },
              base: "main",
              head: "feature/pages",
              labels: ["bug"],
              review_decision: "REVIEW_REQUIRED",
              checks: "FAILURE",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
            },
          ],
        })
        expect((github.requests[0].body as { variables: unknown }).variables).toEqual({
          q: "is:pr is:open repo:acme/widgets author:octo label:bug sort:updated-desc",
          first: 5,
        })
      }),
    ),
  )

  it.live("prs leaves out the repo qualifier when the query names an org, even without a git checkout", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GRAPHQL search(type: ISSUE": { body: { search: { issueCount: 0, nodes: [] } } },
        })
        const result = yield* run<object, { query: string }>(tool("prs"), { state: "merged", query: "org:acme flaky" })
        expect(result.query).toBe("is:pr is:merged org:acme flaky sort:updated-desc")
        expect((github.requests[0].body as { variables: { q: string } }).variables.q).toBe(
          "is:pr is:merged org:acme flaky sort:updated-desc",
        )
      }),
    ),
  )

  it.live("pr_create fails with a push hint when the head branch is not on GitHub", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/branches/feature/pages": { status: 404, body: { message: "Branch not found" } },
        })
        const error = yield* run(tool("pr_create"), {
          repo: "acme/widgets",
          title: "Add pagination",
          head: "feature/pages",
        }).pipe(Effect.flip)
        expect(error.message).toContain("Branch feature/pages does not exist on acme/widgets.")
        expect(error.message).toContain("git push -u origin feature/pages")
        expect(writes(github.requests)).toEqual([])
      }),
    ),
  )

  it.live("pr_create opens the pull request, labels it and requests reviewers, mapping the copilot alias", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool, asserted } = yield* setup({
          "GET /repos/acme/widgets/branches/feature/pages": { body: { name: "feature/pages" } },
          "GET /repos/acme/widgets": { body: { default_branch: "trunk" } },
          "POST /repos/acme/widgets/pulls": {
            status: 201,
            body: { ...restPull({ draft: true }), base: { ref: "trunk", repo: { full_name: "acme/widgets" } } },
          },
          "POST /repos/acme/widgets/issues/7/labels": { body: [{ name: "enhancement" }] },
          "POST /repos/acme/widgets/pulls/7/requested_reviewers": (request) =>
            (request.body as { reviewers: string[] }).reviewers.length > 1
              ? { status: 422, body: { message: "Reviews may only be requested from collaborators." } }
              : (request.body as { reviewers: string[] }).reviewers[0] === "stranger"
                ? { status: 422, body: { message: "Reviews may only be requested from collaborators." } }
                : { body: { requested_reviewers: [{ login: "Copilot" }] } },
        })
        const result = yield* run<object, unknown>(tool("pr_create"), {
          repo: "acme/widgets",
          title: "Add pagination",
          body: "Pages results.",
          head: "feature/pages",
          draft: true,
          labels: ["enhancement"],
          reviewers: ["copilot", "stranger"],
        })
        expect(result).toEqual({
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          title: "Add pagination",
          base: "trunk",
          head: "feature/pages",
          draft: true,
          requested_reviewers: ["Copilot"],
          labels: ["enhancement"],
          warnings: [
            "reviewer stranger: POST /repos/acme/widgets/pulls/7/requested_reviewers failed (422): Reviews may only be requested from collaborators.",
          ],
        })
        expect(writes(github.requests)).toEqual([
          [
            "POST",
            "/repos/acme/widgets/pulls",
            { title: "Add pagination", head: "feature/pages", base: "trunk", body: "Pages results.", draft: true },
          ],
          ["POST", "/repos/acme/widgets/issues/7/labels", { labels: ["enhancement"] }],
          [
            "POST",
            "/repos/acme/widgets/pulls/7/requested_reviewers",
            { reviewers: ["copilot-pull-request-reviewer[bot]", "stranger"] },
          ],
          [
            "POST",
            "/repos/acme/widgets/pulls/7/requested_reviewers",
            { reviewers: ["copilot-pull-request-reviewer[bot]"] },
          ],
          ["POST", "/repos/acme/widgets/pulls/7/requested_reviewers", { reviewers: ["stranger"] }],
        ])
        expect(asserted.map((assertion) => assertion.action)).toEqual(["github_pr_create"])
      }),
    ),
  )

  it.live("pr_update converts to draft and marks ready with the matching mutations", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const state = { draft: false }
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/pulls/7": () => ({ body: restPull({ draft: state.draft }) }),
          "GRAPHQL convertPullRequestToDraft": () => {
            state.draft = true
            return { body: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } }
          },
          "GRAPHQL markPullRequestReadyForReview": () => {
            state.draft = false
            return { body: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }
          },
        })
        const drafted = yield* run<object, unknown>(tool("pr_update"), { repo: "acme/widgets", pr: 7, draft: true })
        expect(drafted).toEqual({
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          state: "open",
          draft: true,
          changed: ["draft"],
        })
        const ready = yield* run<object, unknown>(tool("pr_update"), { repo: "acme/widgets", pr: 7, draft: false })
        expect(ready).toEqual({
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          state: "open",
          draft: false,
          changed: ["draft"],
        })
        const mutations = github.requests
          .filter((request) => request.path === "/graphql")
          .map((request) => {
            const body = request.body as { query: string; variables: unknown }
            return [/(convertPullRequestToDraft|markPullRequestReadyForReview)/.exec(body.query)?.[1], body.variables]
          })
        expect(mutations).toEqual([
          ["convertPullRequestToDraft", { id: "PR_7" }],
          ["markPullRequestReadyForReview", { id: "PR_7" }],
        ])
      }),
    ),
  )

  it.live("pr_update edits fields, labels and reviewers", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/pulls/7": { body: { ...restPull(), state: "closed" } },
          "PATCH /repos/acme/widgets/pulls/7": { body: restPull() },
          "DELETE /repos/acme/widgets/issues/7/labels/needs%20triage": {
            status: 404,
            body: { message: "Label does not exist" },
          },
          "DELETE /repos/acme/widgets/pulls/7/requested_reviewers": { body: {} },
        })
        const result = yield* run<object, { state: string; changed: string[] }>(tool("pr_update"), {
          repo: "acme/widgets",
          pr: 7,
          title: "New title",
          state: "closed",
          remove_labels: ["needs triage"],
          remove_reviewers: ["copilot", "acme/core"],
        })
        expect(result.state).toBe("closed")
        expect(result.changed).toEqual(["title", "state", "remove_labels", "remove_reviewers"])
        expect(writes(github.requests)).toEqual([
          ["PATCH", "/repos/acme/widgets/pulls/7", { title: "New title", state: "closed" }],
          ["DELETE", "/repos/acme/widgets/issues/7/labels/needs%20triage", undefined],
          [
            "DELETE",
            "/repos/acme/widgets/pulls/7/requested_reviewers",
            { reviewers: ["copilot-pull-request-reviewer[bot]"], team_reviewers: ["core"] },
          ],
        ])
      }),
    ),
  )

  it.live("pr_merge picks the first allowed method, passes expected_head as sha, and deletes a same-repo branch", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/pulls/7": { body: restPull() },
          "GET /repos/acme/widgets": {
            body: {
              default_branch: "main",
              allow_merge_commit: false,
              allow_squash_merge: true,
              allow_rebase_merge: true,
            },
          },
          "PUT /repos/acme/widgets/pulls/7/merge": {
            body: { sha: "m".repeat(40), merged: true, message: "Pull Request successfully merged" },
          },
          "DELETE /repos/acme/widgets/git/refs/heads/feature/pages": { status: 204 },
        })
        const result = yield* run<object, unknown>(tool("pr_merge"), {
          repo: "acme/widgets",
          pr: 7,
          expected_head: HEAD,
          delete_branch: true,
        })
        expect(result).toEqual({
          merged: true,
          sha: "m".repeat(40),
          message: "Merged #7 (squash). Deleted branch feature/pages.",
          branch_deleted: true,
        })
        expect(writes(github.requests)).toEqual([
          ["PUT", "/repos/acme/widgets/pulls/7/merge", { merge_method: "squash", sha: HEAD }],
          ["DELETE", "/repos/acme/widgets/git/refs/heads/feature/pages", undefined],
        ])
      }),
    ),
  )

  it.live("pr_merge uses the merge_method preference and keeps a fork's branch", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool, kv } = yield* setup({
          "GET /repos/acme/widgets/pulls/7": { body: restPull({ headRepo: "someone/widgets" }) },
          "GET /repos/acme/widgets": { body: { default_branch: "main" } },
          "PUT /repos/acme/widgets/pulls/7/merge": { body: { sha: "m".repeat(40), merged: true } },
        })
        yield* GitHubPreferences.write(
          kv,
          GitHubPreferences.repoKey({ host: "github.com", owner: "acme", name: "widgets" }),
          { merge_method: "rebase" },
          [],
        )
        const result = yield* run<object, { branch_deleted?: boolean; message: string }>(tool("pr_merge"), {
          repo: "acme/widgets",
          pr: 7,
          delete_branch: true,
        })
        expect(result.branch_deleted).toBe(false)
        expect(result.message).toBe("Merged #7 (rebase). Head branch kept: it lives in another repository.")
        expect(writes(github.requests)).toEqual([
          ["PUT", "/repos/acme/widgets/pulls/7/merge", { merge_method: "rebase" }],
        ])
      }),
    ),
  )

  it.live("pr_merge explains a refused merge and enables auto-merge with the method", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool } = yield* setup({
          "GET /repos/acme/widgets/pulls/7": { body: restPull() },
          "PUT /repos/acme/widgets/pulls/7/merge": {
            status: 405,
            body: { message: "Required status check is failing" },
          },
          "GRAPHQL enablePullRequestAutoMerge": {
            body: { enablePullRequestAutoMerge: { pullRequest: { number: 7 } } },
          },
        })
        const error = yield* run(tool("pr_merge"), { repo: "acme/widgets", pr: 7, method: "merge" }).pipe(Effect.flip)
        expect(error.message).toContain(
          "#7 cannot be merged: PUT /repos/acme/widgets/pulls/7/merge failed (405): Required status check is failing",
        )
        expect(error.message).toContain("pass auto: true")
        const auto = yield* run<object, unknown>(tool("pr_merge"), {
          repo: "acme/widgets",
          pr: 7,
          method: "squash",
          auto: true,
        })
        expect(auto).toEqual({
          merged: false,
          auto_merge: "squash",
          message: "Auto-merge (squash) enabled for #7; it merges once requirements pass.",
        })
        const mutation = github.requests.find((request) => request.path === "/graphql")
        expect((mutation?.body as { variables: unknown }).variables).toEqual({
          id: "PR_7",
          method: "SQUASH",
          headline: null,
          body: null,
          sha: null,
        })
      }),
    ),
  )

  it.live("pr_files filters by glob and sums the matches", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { tool } = yield* setup({
          "GET /repos/acme/widgets/pulls/7/files": {
            body: [
              { filename: "src/page.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1 +1 @@" },
              { filename: "src/page.test.ts", status: "added", additions: 30, deletions: 0, patch: "@@ +1,30 @@" },
              {
                filename: "test/old.test.ts",
                status: "renamed",
                additions: 1,
                deletions: 4,
                previous_filename: "test/legacy.test.ts",
              },
            ],
          },
        })
        const result = yield* run<object, unknown>(tool("pr_files"), {
          repo: "acme/widgets",
          pr: 7,
          path: "*.test.ts",
          patch: true,
        })
        expect(result).toEqual({
          total: 2,
          additions: 31,
          deletions: 4,
          truncated: false,
          files: [
            { path: "src/page.test.ts", status: "added", additions: 30, deletions: 0, patch: "@@ +1,30 @@" },
            {
              path: "test/old.test.ts",
              status: "renamed",
              additions: 1,
              deletions: 4,
              previous_path: "test/legacy.test.ts",
            },
          ],
        })
      }),
    ),
  )

  it.live("review maps event names and inline comments, and explains self-approval", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { github, tool, asserted } = yield* setup({
          "POST /repos/acme/widgets/pulls/7/reviews": (request) =>
            (request.body as { event: string }).event === "APPROVE"
              ? {
                  status: 422,
                  body: { message: "Unprocessable Entity", errors: ["Can not approve your own pull request"] },
                }
              : {
                  body: {
                    id: 55,
                    state: "CHANGES_REQUESTED",
                    html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
                  },
                },
        })
        const result = yield* run<object, unknown>(tool("review"), {
          repo: "acme/widgets",
          pr: 7,
          event: "request_changes",
          body: "Cap the retries.",
          comments: [{ path: "src/retry.ts", line: 44, start_line: 40, body: "Unbounded loop." }],
        })
        expect(result).toEqual({
          id: 55,
          state: "CHANGES_REQUESTED",
          url: "https://github.com/acme/widgets/pull/7#pullrequestreview-55",
        })
        const error = yield* run(tool("review"), { repo: "acme/widgets", pr: 7, event: "approve" }).pipe(Effect.flip)
        expect(error.message).toContain("submit event: comment instead")
        expect(writes(github.requests)).toEqual([
          [
            "POST",
            "/repos/acme/widgets/pulls/7/reviews",
            {
              event: "REQUEST_CHANGES",
              body: "Cap the retries.",
              comments: [
                {
                  path: "src/retry.ts",
                  line: 44,
                  body: "Unbounded loop.",
                  side: "RIGHT",
                  start_line: 40,
                  start_side: "RIGHT",
                },
              ],
            },
          ],
          ["POST", "/repos/acme/widgets/pulls/7/reviews", { event: "APPROVE" }],
        ])
        expect(asserted.map((assertion) => assertion.action)).toEqual(["github_review", "github_review"])
      }),
    ),
  )
})
