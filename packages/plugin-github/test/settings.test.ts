import { describe, expect } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import type { GitHubProcess } from "../src/process.js"
import { GitHubSettings } from "../src/settings.js"
import { it, tmpdirScoped, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Request } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }
const forbidden = { status: 403, body: { message: "Must have admin rights to Repository." } }
const missing = { status: 404, body: { message: "Not Found" } }

const calls = (requests: ReadonlyArray<Request>, method?: string) =>
  requests
    .filter((request) => method === undefined || request.method === method)
    .map((request) => `${request.method} ${request.path}`)

const writes = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.method !== "GET")
    .map((request) => ({ method: request.method, path: request.path, body: request.body }))

/** A process runner that records gh invocations and answers with the given result; git calls report no remotes. */
function fakeRun(result: GitHubProcess.Result = { exitCode: 0, stdout: "", stderr: "" }) {
  const invoked: Array<{ command: string; args: ReadonlyArray<string>; input?: string; host?: string }> = []
  const runner: GitHubProcess.Run = (command, args, options) =>
    Effect.sync(() => {
      if (command !== "gh") return { exitCode: 1, stdout: "", stderr: "" }
      invoked.push({ command, args, input: options?.input, host: options?.env?.GH_HOST })
      return result
    })
  return { runner, invoked }
}

describe("github settings tools", () => {
  it.live("variables all lists repository, environment and shared organization variables; 403 becomes a note", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/variables": {
            body: {
              total_count: 1,
              variables: [{ name: "REGION", value: "us-east-1", updated_at: "2026-01-01T00:00:00Z" }],
            },
          },
          "GET /repos/acme/widgets/environments": {
            body: { total_count: 2, environments: [{ name: "prod" }, { name: "staging" }] },
          },
          "GET /repos/acme/widgets/environments/prod/variables": {
            body: { total_count: 1, variables: [{ name: "URL", value: "https://prod.example" }] },
          },
          "GET /repos/acme/widgets/environments/staging/variables": forbidden,
          "GET /repos/acme/widgets/actions/organization-variables": {
            body: { total_count: 1, variables: [{ name: "ORG_WIDE", value: "1", visibility: "all" }] },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubSettings.tools(deps), "variables"), { repo: "acme/widgets" })).toEqual({
          variables: [
            { name: "REGION", value: "us-east-1", scope: "repo", updated_at: "2026-01-01T00:00:00Z" },
            { name: "URL", value: "https://prod.example", scope: "environment", environment: "prod" },
            { name: "ORG_WIDE", value: "1", scope: "org", org: "acme", visibility: "all" },
          ],
          notes: ["environment staging: requires admin access"],
        })
      }),
    ),
  )

  it.live("variables org scope reads the organization endpoint with visibility", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /orgs/acme/actions/variables": {
            body: { total_count: 1, variables: [{ name: "SHARED", value: "x", visibility: "selected" }] },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubSettings.tools(deps), "variables"), { repo: "acme/widgets", scope: "org" }),
        ).toEqual({
          variables: [{ name: "SHARED", value: "x", scope: "org", org: "acme", visibility: "selected" }],
          notes: [],
        })
      }),
    ),
  )

  it.live("variable_set updates with PATCH, creates with POST after a 404, and deletes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PATCH /repos/acme/widgets/actions/variables/REGION": { status: 204 },
          "PATCH /repos/acme/widgets/environments/prod/variables/URL": missing,
          "POST /repos/acme/widgets/environments/prod/variables": { status: 201 },
          "DELETE /repos/acme/widgets/actions/variables/OLD": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "variable_set")
        expect(yield* run(tool, { repo: "acme/widgets", name: "REGION", value: "eu-west-1" })).toEqual({
          name: "REGION",
          scope: "repo",
          action: "updated",
        })
        expect(
          yield* run(tool, {
            repo: "acme/widgets",
            name: "URL",
            value: "https://prod.example",
            scope: "environment",
            environment: "prod",
          }),
        ).toEqual({ name: "URL", scope: "environment", environment: "prod", action: "created" })
        expect(yield* run(tool, { repo: "acme/widgets", name: "OLD", delete: true })).toEqual({
          name: "OLD",
          scope: "repo",
          action: "deleted",
        })
        expect(writes(github.requests)).toEqual([
          {
            method: "PATCH",
            path: "/repos/acme/widgets/actions/variables/REGION",
            body: { name: "REGION", value: "eu-west-1" },
          },
          {
            method: "PATCH",
            path: "/repos/acme/widgets/environments/prod/variables/URL",
            body: { name: "URL", value: "https://prod.example" },
          },
          {
            method: "POST",
            path: "/repos/acme/widgets/environments/prod/variables",
            body: { name: "URL", value: "https://prod.example" },
          },
          { method: "DELETE", path: "/repos/acme/widgets/actions/variables/OLD", body: undefined },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_variable_set", ["github.com/acme/widgets"]],
          ["github_variable_set", ["github.com/acme/widgets"]],
          ["github_variable_set", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("variable_set org selected visibility resolves repository names to ids", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/api": { body: { id: 11 } },
          "GET /repos/acme/web": { body: { id: 12 } },
          "PATCH /orgs/acme/actions/variables/SHARED": missing,
          "POST /orgs/acme/actions/variables": { status: 201 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubSettings.tools(deps), "variable_set"), {
            name: "SHARED",
            value: "x",
            scope: "org",
            org: "acme",
            visibility: "selected",
            repositories: ["api", "web"],
          }),
        ).toEqual({ name: "SHARED", scope: "org", org: "acme", action: "created" })
        expect(writes(github.requests).at(-1)).toEqual({
          method: "POST",
          path: "/orgs/acme/actions/variables",
          body: { name: "SHARED", value: "x", visibility: "selected", selected_repository_ids: [11, 12] },
        })
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_variable_set", ["github.com/acme/*"]],
        ])
      }),
    ),
  )

  it.live("secrets lists names only across scopes and uses the dependabot path", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/secrets": {
            body: { total_count: 1, secrets: [{ name: "NPM_TOKEN", created_at: "2026-01-01T00:00:00Z" }] },
          },
          "GET /repos/acme/widgets/environments": { body: { total_count: 1, environments: [{ name: "prod" }] } },
          "GET /repos/acme/widgets/environments/prod/secrets": {
            body: { total_count: 1, secrets: [{ name: "DEPLOY_KEY" }] },
          },
          "GET /repos/acme/widgets/actions/organization-secrets": missing,
          "GET /repos/acme/widgets/dependabot/secrets": {
            body: { total_count: 1, secrets: [{ name: "REGISTRY" }] },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "secrets")
        expect(yield* run(tool, { repo: "acme/widgets" })).toEqual({
          secrets: [
            { name: "NPM_TOKEN", scope: "repo", app: "actions", created_at: "2026-01-01T00:00:00Z" },
            { name: "DEPLOY_KEY", scope: "environment", environment: "prod", app: "actions" },
          ],
          notes: ["organization: not found or requires admin access"],
        })
        expect(yield* run(tool, { repo: "acme/widgets", app: "dependabot" })).toEqual({
          secrets: [{ name: "REGISTRY", scope: "repo", app: "dependabot" }],
          notes: [],
        })
        expect(calls(github.requests).at(-1)).toBe("GET /repos/acme/widgets/dependabot/secrets")
      }),
    ),
  )

  it.live("secret_set pipes the value to gh on stdin and keeps it out of the arguments", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({})
        const made = yield* makeDeps({ http: github.http })
        const fake = fakeRun()
        const tools = GitHubSettings.tools({ ...made.deps, run: fake.runner })
        expect(
          yield* run(find(tools, "secret_set"), {
            repo: "acme/widgets",
            name: "API_KEY",
            value: "s3cr3t-value",
            scope: "environment",
            environment: "prod",
          }),
        ).toEqual({ name: "API_KEY", scope: "environment", environment: "prod", app: "actions", action: "set" })
        expect(fake.invoked).toEqual([
          {
            command: "gh",
            args: [
              "secret",
              "set",
              "API_KEY",
              "--app",
              "actions",
              "--repo",
              "github.com/acme/widgets",
              "--env",
              "prod",
            ],
            input: "s3cr3t-value",
            host: "github.com",
          },
        ])
        expect(fake.invoked[0]?.args.join(" ")).not.toContain("s3cr3t-value")
        expect(made.asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_secret_set", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("secret_set reads from_file through the read approval and from_env from the process", () =>
    withEnv({ ...env, SETTINGS_TEST_SECRET: "from-env-value" }, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(() => writeFile(path.join(tmp.path, "token.txt"), "file-value"))
        const made = yield* makeDeps({ http: fakeGitHub({}).http, directory: tmp.path })
        const fake = fakeRun()
        const tool = find(GitHubSettings.tools({ ...made.deps, run: fake.runner }), "secret_set")
        yield* run(tool, {
          repo: "acme/widgets",
          name: "TOKEN",
          from_file: "token.txt",
          scope: "org",
          org: "acme",
          visibility: "selected",
          repositories: ["api", "web"],
        })
        yield* run(tool, { repo: "acme/widgets", name: "OTHER", from_env: "SETTINGS_TEST_SECRET", app: "dependabot" })
        expect(made.approvals).toEqual([{ kind: "read", path: path.join(tmp.path, "token.txt") }])
        expect(fake.invoked).toEqual([
          {
            command: "gh",
            args: [
              "secret",
              "set",
              "TOKEN",
              "--app",
              "actions",
              "--org",
              "acme",
              "--visibility",
              "selected",
              "--repos",
              "api,web",
            ],
            input: "file-value",
            host: "github.com",
          },
          {
            command: "gh",
            args: ["secret", "set", "OTHER", "--app", "dependabot", "--repo", "github.com/acme/widgets"],
            input: "from-env-value",
            host: "github.com",
          },
        ])
        expect(made.asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_secret_set", ["github.com/acme/*"]],
          ["github_secret_set", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("secret_set refuses an empty value, deletes over REST and redacts the value from gh errors", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({ "DELETE /repos/acme/widgets/actions/secrets/OLD": { status: 204 } })
        const made = yield* makeDeps({ http: github.http })
        const fake = fakeRun({ exitCode: 1, stdout: "", stderr: "failed to set secret hunter2: HTTP 422" })
        const tool = find(GitHubSettings.tools({ ...made.deps, run: fake.runner }), "secret_set")
        const empty = yield* run(tool, { repo: "acme/widgets", name: "X", value: "" }).pipe(Effect.flip)
        expect(String(empty.message)).toContain("Refusing to set an empty secret")
        expect(yield* run(tool, { repo: "acme/widgets", name: "OLD", delete: true })).toEqual({
          name: "OLD",
          scope: "repo",
          app: "actions",
          action: "deleted",
        })
        expect(writes(github.requests)).toEqual([
          { method: "DELETE", path: "/repos/acme/widgets/actions/secrets/OLD", body: undefined },
        ])
        const failed = yield* run(tool, { repo: "acme/widgets", name: "PW", value: "hunter2" }).pipe(Effect.flip)
        expect(String(failed.message)).toContain("failed to set secret [redacted]: HTTP 422")
        expect(String(failed.message)).not.toContain("hunter2")
        // The empty value is refused before asking permission; delete and the failed set both asked.
        expect(made.asserted.map((item) => item.action)).toEqual(["github_secret_set", "github_secret_set"])
      }),
    ),
  )

  it.live("secret_set reports a missing gh as unsupported", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const made = yield* makeDeps({ http: fakeGitHub({}).http })
        const fake = fakeRun({ exitCode: 127, stdout: "", stderr: "spawn gh ENOENT" })
        const failed = yield* run(find(GitHubSettings.tools({ ...made.deps, run: fake.runner }), "secret_set"), {
          repo: "acme/widgets",
          name: "PW",
          value: "v",
        }).pipe(Effect.flip)
        expect(failed).toMatchObject({ metadata: { kind: "unsupported" } })
        expect(String(failed.message)).toContain("cli.github.com")
      }),
    ),
  )

  it.live("environments maps reviewers, branch patterns and counts", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/environments": {
            body: {
              total_count: 2,
              environments: [
                {
                  name: "prod",
                  html_url: "https://github.com/acme/widgets/deployments/activity_log?environments_filter=prod",
                  can_admins_bypass: false,
                  protection_rules: [
                    { type: "wait_timer", wait_timer: 30 },
                    {
                      type: "required_reviewers",
                      prevent_self_review: true,
                      reviewers: [
                        { type: "User", reviewer: { login: "octocat", id: 1 } },
                        { type: "Team", reviewer: { slug: "sre", id: 2 } },
                      ],
                    },
                    { type: "branch_policy" },
                  ],
                  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
                },
                { name: "dev", deployment_branch_policy: null },
              ],
            },
          },
          "GET /repos/acme/widgets/environments/prod/deployment-branch-policies": {
            body: {
              total_count: 2,
              branch_policies: [
                { id: 1, name: "main", type: "branch" },
                { id: 2, name: "v*", type: "tag" },
              ],
            },
          },
          "GET /repos/acme/widgets/environments/prod/variables": { body: { total_count: 3, variables: [] } },
          "GET /repos/acme/widgets/environments/prod/secrets": { body: { total_count: 2, secrets: [] } },
          "GET /repos/acme/widgets/environments/dev/variables": { body: { total_count: 0, variables: [] } },
          "GET /repos/acme/widgets/environments/dev/secrets": forbidden,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubSettings.tools(deps), "environments"), { repo: "acme/widgets" })).toEqual({
          environments: [
            {
              name: "prod",
              url: "https://github.com/acme/widgets/deployments/activity_log?environments_filter=prod",
              wait_timer: 30,
              prevent_self_review: true,
              reviewers: [
                { type: "User", login: "octocat" },
                { type: "Team", login: "sre" },
              ],
              can_admins_bypass: false,
              deployment_branch_policy: {
                protected_branches: false,
                custom_branch_policies: true,
                branches: ["main", "tag:v*"],
              },
              counts: { variables: 3, secrets: 2 },
            },
            {
              name: "dev",
              reviewers: [],
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
              counts: { variables: 0 },
            },
          ],
          notes: [],
        })
      }),
    ),
  )

  it.live("environment_update resolves reviewers to ids and syncs branch patterns", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /users/octocat": { body: { id: 101, login: "octocat" } },
          "GET /orgs/acme/teams/sre": { body: { id: 202, slug: "sre" } },
          "PUT /repos/acme/widgets/environments/prod": { body: { name: "prod" } },
          "GET /repos/acme/widgets/environments/prod/deployment-branch-policies": {
            body: {
              total_count: 2,
              branch_policies: [
                { id: 7, name: "main", type: "branch" },
                { id: 8, name: "old/*", type: "branch" },
              ],
            },
          },
          "POST /repos/acme/widgets/environments/prod/deployment-branch-policies": { body: { id: 9 } },
          "DELETE /repos/acme/widgets/environments/prod/deployment-branch-policies/8": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubSettings.tools(deps), "environment_update"), {
            repo: "acme/widgets",
            name: "prod",
            wait_timer: 5,
            reviewers: [
              { type: "User", login: "octocat" },
              { type: "Team", login: "sre" },
            ],
            branches: ["main", "release/*", "tag:v*"],
          }),
        ).toEqual({
          name: "prod",
          action: "updated",
          changed: ["wait_timer", "reviewers", "branches", "added release/*", "added tag:v*", "removed old/*"],
        })
        expect(writes(github.requests)).toEqual([
          {
            method: "PUT",
            path: "/repos/acme/widgets/environments/prod",
            body: {
              wait_timer: 5,
              reviewers: [
                { type: "User", id: 101 },
                { type: "Team", id: 202 },
              ],
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
            },
          },
          {
            method: "POST",
            path: "/repos/acme/widgets/environments/prod/deployment-branch-policies",
            body: { name: "release/*", type: "branch" },
          },
          {
            method: "POST",
            path: "/repos/acme/widgets/environments/prod/deployment-branch-policies",
            body: { name: "v*", type: "tag" },
          },
          {
            method: "DELETE",
            path: "/repos/acme/widgets/environments/prod/deployment-branch-policies/8",
            body: undefined,
          },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_environment_update", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("environment_update deletes and maps protected branches", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "DELETE /repos/acme/widgets/environments/old": { status: 204 },
          "PUT /repos/acme/widgets/environments/stage": { body: { name: "stage" } },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "environment_update")
        expect(yield* run(tool, { repo: "acme/widgets", name: "old", delete: true })).toEqual({
          name: "old",
          action: "deleted",
          changed: [],
        })
        expect(yield* run(tool, { repo: "acme/widgets", name: "stage", branches: "protected" })).toEqual({
          name: "stage",
          action: "updated",
          changed: ["branches"],
        })
        expect(writes(github.requests)).toEqual([
          { method: "DELETE", path: "/repos/acme/widgets/environments/old", body: undefined },
          {
            method: "PUT",
            path: "/repos/acme/widgets/environments/stage",
            body: { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } },
          },
        ])
      }),
    ),
  )

  it.live("rulesets lists details including parents and shows the rules for a branch", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/rulesets": {
            body: [
              { id: 1, name: "main", enforcement: "active" },
              { id: 2, name: "org-wide", enforcement: "evaluate" },
            ],
          },
          "GET /repos/acme/widgets/rulesets/1": {
            body: {
              id: 1,
              name: "main",
              target: "branch",
              enforcement: "active",
              source: "acme/widgets",
              source_type: "Repository",
              conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
              rules: [
                { type: "deletion" },
                { type: "pull_request", parameters: { required_approving_review_count: 1 } },
              ],
              bypass_actors: [{ actor_type: "OrganizationAdmin", actor_id: null, bypass_mode: "always" }],
              _links: { html: { href: "https://github.com/acme/widgets/rules/1" } },
            },
          },
          "GET /repos/acme/widgets/rulesets/2": forbidden,
          "GET /repos/acme/widgets/rules/branches/release/v1": {
            body: [{ type: "non_fast_forward", ruleset_id: 1, ruleset_source: "acme/widgets" }],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "rulesets")
        expect(yield* run(tool, { repo: "acme/widgets" })).toEqual({
          rulesets: [
            {
              id: 1,
              name: "main",
              target: "branch",
              enforcement: "active",
              source: "acme/widgets",
              source_type: "Repository",
              conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
              rules: [
                { type: "deletion" },
                { type: "pull_request", parameters: { required_approving_review_count: 1 } },
              ],
              bypass_actors: [{ actor_type: "OrganizationAdmin", bypass_mode: "always" }],
              url: "https://github.com/acme/widgets/rules/1",
            },
            { id: 2, name: "org-wide", enforcement: "evaluate" },
          ],
          notes: ["ruleset 2: requires admin access"],
        })
        expect(github.requests[0]?.query.includes_parents).toBe("true")
        expect(yield* run(tool, { repo: "acme/widgets", branch: "release/v1" })).toEqual({
          branch: "release/v1",
          rules: [{ type: "non_fast_forward", ruleset_id: 1 }],
          notes: [],
        })
      }),
    ),
  )

  it.live("ruleset_update creates, updates and deletes at the right endpoints", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const created = {
          id: 5,
          name: "protect",
          enforcement: "active",
          _links: { html: { href: "https://github.com/acme/widgets/rules/5" } },
        }
        const github = fakeGitHub({
          "POST /repos/acme/widgets/rulesets": { status: 201, body: created },
          "PUT /repos/acme/widgets/rulesets/5": { body: { ...created, enforcement: "evaluate" } },
          "DELETE /orgs/acme/rulesets/9": { status: 204 },
          "PUT /repos/acme/widgets/rulesets/6": {
            status: 422,
            body: { message: "Validation Failed", errors: ["Invalid rule 'nope'"] },
          },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "ruleset_update")
        const ruleset = { name: "protect", target: "branch", enforcement: "active", rules: [{ type: "deletion" }] }
        expect(yield* run(tool, { repo: "acme/widgets", ruleset })).toEqual({
          id: 5,
          name: "protect",
          action: "created",
          enforcement: "active",
          url: "https://github.com/acme/widgets/rules/5",
        })
        expect(
          yield* run(tool, { repo: "acme/widgets", id: 5, ruleset: { ...ruleset, enforcement: "evaluate" } }),
        ).toEqual({
          id: 5,
          name: "protect",
          action: "updated",
          enforcement: "evaluate",
          url: "https://github.com/acme/widgets/rules/5",
        })
        expect(yield* run(tool, { org: "acme", id: 9, delete: true })).toEqual({ id: 9, action: "deleted" })
        const failed = yield* run(tool, { repo: "acme/widgets", id: 6, ruleset }).pipe(Effect.flip)
        expect(failed).toMatchObject({ metadata: { kind: "validation", status: 422 } })
        expect(String(failed.message)).toContain("Invalid rule 'nope'")
        expect(writes(github.requests)).toEqual([
          { method: "POST", path: "/repos/acme/widgets/rulesets", body: ruleset },
          { method: "PUT", path: "/repos/acme/widgets/rulesets/5", body: { ...ruleset, enforcement: "evaluate" } },
          { method: "DELETE", path: "/orgs/acme/rulesets/9", body: undefined },
          { method: "PUT", path: "/repos/acme/widgets/rulesets/6", body: ruleset },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_ruleset_update", ["github.com/acme/widgets"]],
          ["github_ruleset_update", ["github.com/acme/widgets"]],
          ["github_ruleset_update", ["github.com/acme/*"]],
          ["github_ruleset_update", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("branch_protection reports full protection, unprotected and admin-only branches", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets": { body: { default_branch: "main" } },
          "GET /repos/acme/widgets/branches/main/protection": {
            body: {
              required_status_checks: {
                strict: true,
                contexts: ["ci"],
                checks: [{ context: "ci", app_id: 15368 }],
              },
              required_pull_request_reviews: {
                required_approving_review_count: 2,
                dismiss_stale_reviews: true,
                require_code_owner_reviews: false,
                require_last_push_approval: true,
                dismissal_restrictions: { users: [{ login: "octocat" }], teams: [], apps: [] },
                bypass_pull_request_allowances: { users: [], teams: [{ slug: "sre" }], apps: [{ slug: "bot" }] },
              },
              enforce_admins: { enabled: true },
              restrictions: null,
              required_linear_history: { enabled: true },
              allow_force_pushes: { enabled: false },
              allow_deletions: { enabled: false },
              required_conversation_resolution: { enabled: true },
              lock_branch: { enabled: false },
              allow_fork_syncing: { enabled: false },
            },
          },
          "GET /repos/acme/widgets/branches/main/protection/required_signatures": { body: { enabled: true } },
          "GET /repos/acme/widgets/branches/feature/x/protection": missing,
          "GET /repos/acme/widgets/branches/locked/protection": forbidden,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "branch_protection")
        expect(yield* run(tool, { repo: "acme/widgets" })).toEqual({
          branch: "main",
          protected: true,
          required_status_checks: { strict: true, contexts: ["ci"], checks: [{ context: "ci", app_id: 15368 }] },
          required_pull_request_reviews: {
            required_approving_review_count: 2,
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            require_last_push_approval: true,
            dismissal: { users: ["octocat"], teams: [], apps: [] },
            bypass: { users: [], teams: ["sre"], apps: ["bot"] },
          },
          enforce_admins: true,
          required_linear_history: true,
          allow_force_pushes: false,
          allow_deletions: false,
          required_signatures: true,
          required_conversation_resolution: true,
          lock_branch: false,
          allow_fork_syncing: false,
        })
        expect(yield* run(tool, { repo: "acme/widgets", branch: "feature/x" })).toEqual({
          branch: "feature/x",
          protected: false,
          note: "not protected (rulesets may still apply; see rulesets with branch)",
        })
        expect(yield* run(tool, { repo: "acme/widgets", branch: "locked" })).toEqual({
          branch: "locked",
          available: false,
          reason: "requires admin access",
          fallback: "rulesets({ branch }) shows the rules that apply",
        })
      }),
    ),
  )

  it.live("branch_protection_update puts the body or deletes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PUT /repos/acme/widgets/branches/main/protection": { body: {} },
          "DELETE /repos/acme/widgets/branches/release/v1/protection": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "branch_protection_update")
        const protection = {
          required_status_checks: null,
          enforce_admins: true,
          required_pull_request_reviews: null,
          restrictions: null,
        }
        expect(yield* run(tool, { repo: "acme/widgets", branch: "main", protection })).toEqual({
          branch: "main",
          action: "updated",
        })
        expect(yield* run(tool, { repo: "acme/widgets", branch: "release/v1", delete: true })).toEqual({
          branch: "release/v1",
          action: "deleted",
        })
        expect(writes(github.requests)).toEqual([
          { method: "PUT", path: "/repos/acme/widgets/branches/main/protection", body: protection },
          { method: "DELETE", path: "/repos/acme/widgets/branches/release/v1/protection", body: undefined },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_branch_protection_update", ["github.com/acme/widgets"]],
          ["github_branch_protection_update", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("repo_update patches only the given fields, puts topics and refuses an empty change", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PATCH /repos/acme/widgets": { body: {} },
          "PUT /repos/acme/widgets/topics": { body: { names: ["cli", "go"] } },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSettings.tools(deps), "repo_update")
        expect(
          yield* run(tool, {
            repo: "acme/widgets",
            description: "Widgets",
            delete_branch_on_merge: true,
            squash_merge_commit_title: "PR_TITLE",
            topics: ["cli", "go"],
          }),
        ).toEqual({
          repo: "acme/widgets",
          changed: ["description", "delete_branch_on_merge", "squash_merge_commit_title", "topics"],
        })
        expect(writes(github.requests)).toEqual([
          {
            method: "PATCH",
            path: "/repos/acme/widgets",
            body: { description: "Widgets", delete_branch_on_merge: true, squash_merge_commit_title: "PR_TITLE" },
          },
          { method: "PUT", path: "/repos/acme/widgets/topics", body: { names: ["cli", "go"] } },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_repo_update", ["github.com/acme/widgets"]],
        ])
        const empty = yield* run(tool, { repo: "acme/widgets" }).pipe(Effect.flip)
        expect(String(empty.message)).toContain("Nothing to change")
        expect(asserted).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "repo_update maps settings-page commit message names, toggles release immutability, reports ignored settings",
    () =>
      withEnv(env, () =>
        Effect.gen(function* () {
          const github = fakeGitHub({
            // GitHub keeps allow_forking when an organization policy decides it, and still answers 200.
            "PATCH /repos/acme/widgets": {
              body: {
                allow_forking: true,
                merge_commit_title: "PR_TITLE",
                merge_commit_message: "PR_BODY",
                squash_merge_commit_title: "PR_TITLE",
                squash_merge_commit_message: "COMMIT_MESSAGES",
              },
            },
            "PUT /repos/acme/widgets/immutable-releases": { status: 204 },
          })
          const { deps } = yield* makeDeps({ http: github.http })
          expect(
            yield* run(find(GitHubSettings.tools(deps), "repo_update"), {
              repo: "acme/widgets",
              allow_forking: false,
              merge_commit_default: "Pull request title and description",
              squash_commit_default: "Pull request title and commit details",
              release_immutability: true,
            }),
          ).toEqual({
            repo: "acme/widgets",
            changed: [
              "merge_commit_title",
              "merge_commit_message",
              "squash_merge_commit_title",
              "squash_merge_commit_message",
              "release_immutability",
            ],
            not_applied: ["allow_forking"],
          })
          expect(writes(github.requests)).toEqual([
            {
              method: "PATCH",
              path: "/repos/acme/widgets",
              body: {
                allow_forking: false,
                merge_commit_title: "PR_TITLE",
                merge_commit_message: "PR_BODY",
                squash_merge_commit_title: "PR_TITLE",
                squash_merge_commit_message: "COMMIT_MESSAGES",
              },
            },
            { method: "PUT", path: "/repos/acme/widgets/immutable-releases", body: undefined },
          ])
        }),
      ),
  )
})
