import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { GitHubAutomation } from "../src/automation.js"
import { it, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Request } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }
const forbidden = { status: 403, body: { message: "Must have admin rights to Repository." } }
const missing = { status: 404, body: { message: "Not Found" } }
const SHA = "a".repeat(40)

const writes = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.method !== "GET")
    .map((request) => ({ method: request.method, path: request.path, body: request.body }))

const calls = (requests: ReadonlyArray<Request>) => requests.map((request) => `${request.method} ${request.path}`)

describe("github automation tools", () => {
  it.live("exports the tools in order", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { deps } = yield* makeDeps({ http: fakeGitHub({}).http })
        const tools = GitHubAutomation.tools(deps)
        expect(tools.map((tool) => tool.name)).toEqual([
          "actions_settings",
          "actions_settings_update",
          "webhooks",
          "webhook_update",
          "pages",
          "pages_update",
          "tags",
          "tag_update",
          "copilot_settings",
          "copilot_settings_update",
        ])
        expect(tools.filter((tool) => tool.description.split("\n")[0].length > 120).map((tool) => tool.name)).toEqual(
          [],
        )
      }),
    ),
  )

  it.live("actions_settings maps every part and reads selected actions only when selected", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/permissions": { body: { enabled: true, allowed_actions: "selected" } },
          "GET /repos/acme/widgets/actions/permissions/selected-actions": {
            body: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["octo/*@v1"] },
          },
          "GET /repos/acme/widgets/actions/permissions/workflow": {
            body: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
          },
          "GET /repos/acme/widgets/actions/permissions/artifact-and-log-retention": {
            body: { days: 30, maximum_allowed_days: 90 },
          },
          "GET /repos/acme/widgets/actions/permissions/fork-pr-contributor-approval": {
            body: { approval_policy: "first_time_contributors" },
          },
          "GET /repos/acme/widgets/actions/permissions/access": {
            status: 422,
            body: { message: "This setting only applies to internal and private repositories." },
          },
          "GET /repos/acme/widgets/actions/oidc/customization/sub": {
            body: { use_default: false, include_claim_keys: ["repo", "context"] },
          },
          "GET /repos/acme/widgets/actions/runners": {
            body: {
              total_count: 1,
              runners: [
                {
                  id: 7,
                  name: "build-1",
                  os: "linux",
                  status: "online",
                  busy: true,
                  labels: [
                    { id: 1, name: "self-hosted" },
                    { id: 2, name: "x64" },
                  ],
                },
              ],
            },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAutomation.tools(deps), "actions_settings"), { repo: "acme/widgets" })).toEqual({
          enabled: true,
          allowed_actions: "selected",
          selected_actions: { github_owned_allowed: true, verified_allowed: false, patterns_allowed: ["octo/*@v1"] },
          workflow_permissions: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
          retention: { days: 30, maximum_allowed_days: 90 },
          fork_pr_approval: "first_time_contributors",
          oidc_subject: { use_default: false, include_claim_keys: ["repo", "context"] },
          runners: [
            { id: 7, name: "build-1", os: "linux", status: "online", busy: true, labels: ["self-hosted", "x64"] },
          ],
          notes: ["access: This setting only applies to internal and private repositories. (422)"],
        })
      }),
    ),
  )

  it.live("actions_settings skips selected actions unless selected and turns 403 and 409 into notes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/permissions": { body: { enabled: true, allowed_actions: "all" } },
          "GET /repos/acme/widgets/actions/permissions/workflow": forbidden,
          "GET /repos/acme/widgets/actions/permissions/artifact-and-log-retention": forbidden,
          "GET /repos/acme/widgets/actions/permissions/fork-pr-contributor-approval": {
            status: 409,
            body: { message: "Conflict" },
          },
          "GET /repos/acme/widgets/actions/permissions/access": missing,
          "GET /repos/acme/widgets/actions/oidc/customization/sub": missing,
          "GET /repos/acme/widgets/actions/runners": { body: { total_count: 0, runners: [] } },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAutomation.tools(deps), "actions_settings"), { repo: "acme/widgets" })).toEqual({
          enabled: true,
          allowed_actions: "all",
          runners: [],
          notes: [
            "workflow permissions: Must have admin rights to Repository. (403)",
            "retention: Must have admin rights to Repository. (403)",
            "fork pull request approval: Conflict (409)",
            "access: Not Found (404)",
            "oidc subject: Not Found (404)",
          ],
        })
        expect(calls(github.requests)).not.toContain("GET /repos/acme/widgets/actions/permissions/selected-actions")
      }),
    ),
  )

  it.live("actions_settings_update reads the current enabled flag when only allowed_actions is given", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/actions/permissions": { body: { enabled: false, allowed_actions: "all" } },
          "PUT /repos/acme/widgets/actions/permissions": { status: 204 },
          "PUT /repos/acme/widgets/actions/permissions/selected-actions": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "actions_settings_update")
        expect(
          yield* run(tool, {
            repo: "acme/widgets",
            allowed_actions: "selected",
            selected_actions: { github_owned_allowed: true, patterns_allowed: ["octo/*"] },
          }),
        ).toEqual({ changed: ["allowed_actions", "selected_actions"] })
        expect(calls(github.requests)).toEqual([
          "GET /repos/acme/widgets/actions/permissions",
          "PUT /repos/acme/widgets/actions/permissions",
          "PUT /repos/acme/widgets/actions/permissions/selected-actions",
        ])
        expect(writes(github.requests)).toEqual([
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions",
            body: { enabled: false, allowed_actions: "selected" },
          },
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions/selected-actions",
            body: { github_owned_allowed: true, patterns_allowed: ["octo/*"] },
          },
        ])
        expect(asserted.map((item) => [item.action, item.resources, item.metadata])).toEqual([
          [
            "github_actions_settings_update",
            ["github.com/acme/widgets"],
            { changed: ["allowed_actions", "selected_actions"] },
          ],
        ])
      }),
    ),
  )

  it.live("actions_settings_update writes each endpoint and refuses an empty change", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PUT /repos/acme/widgets/actions/permissions": { status: 204 },
          "PUT /repos/acme/widgets/actions/permissions/workflow": { status: 204 },
          "PUT /repos/acme/widgets/actions/permissions/artifact-and-log-retention": { status: 204 },
          "PUT /repos/acme/widgets/actions/permissions/fork-pr-contributor-approval": { status: 204 },
          "PUT /repos/acme/widgets/actions/permissions/access": { status: 204 },
          "PUT /repos/acme/widgets/actions/oidc/customization/sub": { status: 201 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "actions_settings_update")
        const empty = yield* run(tool, { repo: "acme/widgets" }).pipe(Effect.flip)
        expect(String(empty.message)).toContain("Nothing to change")
        yield* run(tool, {
          repo: "acme/widgets",
          enabled: true,
          allowed_actions: "local_only",
          default_workflow_permissions: "read",
          can_approve_pull_request_reviews: false,
          retention_days: 14,
          fork_pr_approval: "all_external_contributors",
          access_level: "organization",
          oidc_subject: { use_default: false, include_claim_keys: ["repo"] },
        })
        expect(writes(github.requests)).toEqual([
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions",
            body: { enabled: true, allowed_actions: "local_only" },
          },
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions/workflow",
            body: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
          },
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions/artifact-and-log-retention",
            body: { days: 14 },
          },
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions/fork-pr-contributor-approval",
            body: { approval_policy: "all_external_contributors" },
          },
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/permissions/access",
            body: { access_level: "organization" },
          },
          {
            method: "PUT",
            path: "/repos/acme/widgets/actions/oidc/customization/sub",
            body: { use_default: false, include_claim_keys: ["repo"] },
          },
        ])
        // Both permissions fields were given, so the current value is not read.
        expect(calls(github.requests).filter((call) => call.startsWith("GET"))).toEqual([])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_actions_settings_update", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("webhooks lists hooks without the secret and one hook with its deliveries", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const hook = {
          id: 5,
          name: "web",
          active: true,
          events: ["push", "pull_request"],
          config: { url: "https://ci.example/hook", content_type: "json", insecure_ssl: "0", secret: "********" },
          last_response: { code: 200, status: "active", message: "OK" },
        }
        const github = fakeGitHub({
          "GET /repos/acme/widgets/hooks": {
            body: [
              hook,
              {
                id: 6,
                name: "web",
                active: false,
                events: ["release"],
                config: { url: "http://old.example", content_type: "form", insecure_ssl: "1" },
                last_response: { code: null, status: "unused", message: null },
              },
            ],
          },
          "GET /repos/acme/widgets/hooks/5": { body: hook },
          "GET /repos/acme/widgets/hooks/5/deliveries": {
            body: [
              {
                id: 900,
                guid: "g",
                event: "pull_request",
                action: "opened",
                status: "OK",
                status_code: 200,
                delivered_at: "2026-10-01T00:00:00Z",
                duration: 0.25,
                redelivery: false,
              },
              {
                id: 901,
                guid: "h",
                event: "push",
                action: null,
                status: "Invalid HTTP Response: 500",
                status_code: 500,
                delivered_at: "2026-10-02T00:00:00Z",
                duration: 1.5,
                redelivery: true,
              },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "webhooks")
        const listed = yield* run<unknown, { hooks: ReadonlyArray<unknown> }>(tool, { repo: "acme/widgets" })
        expect(listed).toEqual({
          hooks: [
            {
              id: 5,
              name: "web",
              active: true,
              events: ["push", "pull_request"],
              url: "https://ci.example/hook",
              content_type: "json",
              insecure_ssl: false,
              has_secret: true,
              last_response: { code: 200, status: "active", message: "OK" },
            },
            {
              id: 6,
              name: "web",
              active: false,
              events: ["release"],
              url: "http://old.example",
              content_type: "form",
              insecure_ssl: true,
              has_secret: false,
              last_response: { status: "unused" },
            },
          ],
        })
        expect(JSON.stringify(listed)).not.toContain("********")
        const one = yield* run(tool, { repo: "acme/widgets", id: 5 })
        expect(one).toEqual({
          hooks: [listed.hooks[0]],
          deliveries: [
            {
              id: 900,
              event: "pull_request",
              action: "opened",
              status: "OK",
              status_code: 200,
              delivered_at: "2026-10-01T00:00:00Z",
              duration: 0.25,
              redelivery: false,
            },
            {
              id: 901,
              event: "push",
              status: "Invalid HTTP Response: 500",
              status_code: 500,
              delivered_at: "2026-10-02T00:00:00Z",
              duration: 1.5,
              redelivery: true,
            },
          ],
        })
        expect(github.requests.at(-1)?.query).toEqual({ per_page: "10" })
      }),
    ),
  )

  it.live("webhook_update creates with a secret from the environment and never echoes it", () =>
    withEnv({ ...env, AUTOMATION_TEST_HOOK_SECRET: "s3cr3t-hook-value" }, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "POST /repos/acme/widgets/hooks": (request) =>
            (request.body as { config: { url: string } }).config.url === "https://bad.example"
              ? { status: 422, body: { message: "Validation failed for s3cr3t-hook-value" } }
              : { status: 201, body: { id: 42, config: { url: "https://ci.example/hook", secret: "********" } } },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "webhook_update")
        const created = yield* run(tool, {
          repo: "acme/widgets",
          action: "create",
          url: "https://ci.example/hook",
          secret_from_env: "AUTOMATION_TEST_HOOK_SECRET",
        })
        expect(created).toEqual({ id: 42, action: "created", url: "https://ci.example/hook" })
        expect(writes(github.requests)).toEqual([
          {
            method: "POST",
            path: "/repos/acme/widgets/hooks",
            body: {
              name: "web",
              active: true,
              events: ["push"],
              config: {
                content_type: "json",
                insecure_ssl: "0",
                url: "https://ci.example/hook",
                secret: "s3cr3t-hook-value",
              },
            },
          },
        ])
        const failed = yield* run(tool, {
          repo: "acme/widgets",
          action: "create",
          url: "https://bad.example",
          secret_from_env: "AUTOMATION_TEST_HOOK_SECRET",
        }).pipe(Effect.flip)
        expect(String(failed.message)).toContain("Validation failed for [redacted]")
        expect(JSON.stringify(created)).not.toContain("s3cr3t-hook-value")
        expect(JSON.stringify(failed)).not.toContain("s3cr3t-hook-value")
        expect(JSON.stringify(asserted)).not.toContain("s3cr3t-hook-value")
        expect(asserted.map((item) => [item.action, item.resources, item.metadata])).toEqual([
          [
            "github_webhook_update",
            ["github.com/acme/widgets"],
            { action: "create", url: "https://ci.example/hook", secret: "set" },
          ],
          [
            "github_webhook_update",
            ["github.com/acme/widgets"],
            { action: "create", url: "https://bad.example", secret: "set" },
          ],
        ])
      }),
    ),
  )

  it.live("webhook_update updates config separately, deletes, pings, tests and redelivers", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PATCH /repos/acme/widgets/hooks/5/config": { body: {} },
          "PATCH /repos/acme/widgets/hooks/5": { body: {} },
          "DELETE /repos/acme/widgets/hooks/5": { status: 204 },
          "POST /repos/acme/widgets/hooks/5/pings": { status: 204 },
          "POST /repos/acme/widgets/hooks/5/tests": { status: 204 },
          "POST /repos/acme/widgets/hooks/5/deliveries/901/attempts": { status: 202, body: {} },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "webhook_update")
        expect(
          yield* run(tool, {
            repo: "acme/widgets",
            action: "update",
            id: 5,
            url: "https://new.example",
            insecure_ssl: true,
            events: ["release"],
          }),
        ).toEqual({ id: 5, action: "updated", url: "https://new.example" })
        expect(yield* run(tool, { repo: "acme/widgets", action: "delete", id: 5 })).toEqual({
          id: 5,
          action: "deleted",
        })
        expect(yield* run(tool, { repo: "acme/widgets", action: "ping", id: 5 })).toEqual({ id: 5, action: "pinged" })
        expect(yield* run(tool, { repo: "acme/widgets", action: "test", id: 5 })).toEqual({ id: 5, action: "tested" })
        expect(yield* run(tool, { repo: "acme/widgets", action: "redeliver", id: 5, delivery_id: 901 })).toEqual({
          id: 5,
          action: "redelivered",
        })
        const noDelivery = yield* run(tool, { repo: "acme/widgets", action: "redeliver", id: 5 }).pipe(Effect.flip)
        expect(String(noDelivery.message)).toContain("redeliver needs delivery_id")
        expect(writes(github.requests)).toEqual([
          {
            method: "PATCH",
            path: "/repos/acme/widgets/hooks/5/config",
            body: { url: "https://new.example", insecure_ssl: "1" },
          },
          { method: "PATCH", path: "/repos/acme/widgets/hooks/5", body: { events: ["release"] } },
          { method: "DELETE", path: "/repos/acme/widgets/hooks/5", body: undefined },
          { method: "POST", path: "/repos/acme/widgets/hooks/5/pings", body: undefined },
          { method: "POST", path: "/repos/acme/widgets/hooks/5/tests", body: undefined },
          { method: "POST", path: "/repos/acme/widgets/hooks/5/deliveries/901/attempts", body: undefined },
        ])
        expect(
          asserted.map((item) => [item.action, item.resources, (item.metadata as { action: string }).action]),
        ).toEqual([
          ["github_webhook_update", ["github.com/acme/widgets"], "update"],
          ["github_webhook_update", ["github.com/acme/widgets"], "delete"],
          ["github_webhook_update", ["github.com/acme/widgets"], "ping"],
          ["github_webhook_update", ["github.com/acme/widgets"], "test"],
          ["github_webhook_update", ["github.com/acme/widgets"], "redeliver"],
        ])
      }),
    ),
  )

  it.live("pages maps a legacy site with its latest build and reports a disabled site", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/pages": {
            body: {
              status: "built",
              html_url: "https://acme.github.io/widgets/",
              build_type: "legacy",
              source: { branch: "main", path: "/docs" },
              cname: "docs.acme.dev",
              https_enforced: true,
              public: true,
            },
          },
          "GET /repos/acme/widgets/pages/builds/latest": {
            body: { status: "errored", error: { message: "Page build failed." }, created_at: "2026-10-01T00:00:00Z" },
          },
          "GET /repos/acme/gadgets/pages": missing,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "pages")
        expect(yield* run(tool, { repo: "acme/widgets" })).toEqual({
          enabled: true,
          status: "built",
          html_url: "https://acme.github.io/widgets/",
          build_type: "legacy",
          cname: "docs.acme.dev",
          https_enforced: true,
          public: true,
          source: { branch: "main", path: "/docs" },
          latest_build: { status: "errored", error: "Page build failed.", created_at: "2026-10-01T00:00:00Z" },
          notes: [],
        })
        expect(yield* run(tool, { repo: "acme/gadgets" })).toEqual({ enabled: false, notes: [] })
      }),
    ),
  )

  it.live("pages_update enables, updates, builds and disables", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "POST /repos/acme/widgets/pages": { status: 201, body: {} },
          "PUT /repos/acme/widgets/pages": { status: 204 },
          "POST /repos/acme/widgets/pages/builds": { status: 201, body: {} },
          "DELETE /repos/acme/widgets/pages": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "pages_update")
        expect(
          yield* run(tool, { repo: "acme/widgets", action: "enable", build_type: "legacy", branch: "main" }),
        ).toEqual({ action: "enabled", changed: ["build_type", "source"] })
        expect(yield* run(tool, { repo: "acme/widgets", action: "update", cname: "", https_enforced: true })).toEqual({
          action: "updated",
          changed: ["cname", "https_enforced"],
        })
        expect(yield* run(tool, { repo: "acme/widgets", action: "build" })).toEqual({ action: "build_requested" })
        expect(yield* run(tool, { repo: "acme/widgets", action: "disable" })).toEqual({ action: "disabled" })
        expect(writes(github.requests)).toEqual([
          {
            method: "POST",
            path: "/repos/acme/widgets/pages",
            body: { build_type: "legacy", source: { branch: "main", path: "/" } },
          },
          { method: "PUT", path: "/repos/acme/widgets/pages", body: { cname: null, https_enforced: true } },
          { method: "POST", path: "/repos/acme/widgets/pages/builds", body: undefined },
          { method: "DELETE", path: "/repos/acme/widgets/pages", body: undefined },
        ])
        expect(
          asserted.map((item) => [item.action, item.resources, (item.metadata as { action: string }).action]),
        ).toEqual([
          ["github_pages_update", ["github.com/acme/widgets"], "enable"],
          ["github_pages_update", ["github.com/acme/widgets"], "update"],
          ["github_pages_update", ["github.com/acme/widgets"], "build"],
          ["github_pages_update", ["github.com/acme/widgets"], "disable"],
        ])
      }),
    ),
  )

  it.live("tags lists names with commit SHAs and points tag protection at rulesets", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/tags": {
            body: [
              { name: "v2.0.0", commit: { sha: "b".repeat(40) } },
              { name: "release/1.0", commit: { sha: SHA } },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAutomation.tools(deps), "tags"), { repo: "acme/widgets", limit: 5 })).toEqual({
          tags: [
            { name: "v2.0.0", sha: "b".repeat(40), url: "https://github.com/acme/widgets/tree/v2.0.0" },
            { name: "release/1.0", sha: SHA, url: "https://github.com/acme/widgets/tree/release/1.0" },
          ],
          note: 'Tag protection is configured through rulesets with target "tag"; see the rulesets tool.',
        })
        expect(github.requests[0]?.query).toEqual({ per_page: "5" })
      }),
    ),
  )

  it.live("tag_update creates lightweight tags from a SHA or branch, annotated tags, and deletes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/commits/feature/x": { body: { sha: "c".repeat(40) } },
          "POST /repos/acme/widgets/git/tags": { status: 201, body: { sha: "d".repeat(40) } },
          "POST /repos/acme/widgets/git/refs": { status: 201, body: {} },
          "DELETE /repos/acme/widgets/git/refs/tags/release/v1%231": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "tag_update")
        expect(yield* run(tool, { repo: "acme/widgets", tag: "v1", ref: SHA })).toEqual({
          tag: "v1",
          action: "created",
          sha: SHA,
        })
        expect(yield* run(tool, { repo: "acme/widgets", tag: "v2", ref: "feature/x", message: "Second" })).toEqual({
          tag: "v2",
          action: "created",
          sha: "c".repeat(40),
        })
        expect(yield* run(tool, { repo: "acme/widgets", tag: "release/v1#1", delete: true })).toEqual({
          tag: "release/v1#1",
          action: "deleted",
        })
        expect(calls(github.requests)).toEqual([
          "POST /repos/acme/widgets/git/refs",
          "GET /repos/acme/widgets/commits/feature/x",
          "POST /repos/acme/widgets/git/tags",
          "POST /repos/acme/widgets/git/refs",
          "DELETE /repos/acme/widgets/git/refs/tags/release/v1%231",
        ])
        expect(writes(github.requests)).toEqual([
          { method: "POST", path: "/repos/acme/widgets/git/refs", body: { ref: "refs/tags/v1", sha: SHA } },
          {
            method: "POST",
            path: "/repos/acme/widgets/git/tags",
            body: { tag: "v2", message: "Second", object: "c".repeat(40), type: "commit" },
          },
          { method: "POST", path: "/repos/acme/widgets/git/refs", body: { ref: "refs/tags/v2", sha: "d".repeat(40) } },
          { method: "DELETE", path: "/repos/acme/widgets/git/refs/tags/release/v1%231", body: undefined },
        ])
        expect(asserted.map((item) => [item.action, item.resources, item.metadata])).toEqual([
          ["github_tag_update", ["github.com/acme/widgets"], { tag: "v1", sha: SHA, action: "create" }],
          [
            "github_tag_update",
            ["github.com/acme/widgets"],
            { tag: "v2", sha: "c".repeat(40), action: "create annotated" },
          ],
          ["github_tag_update", ["github.com/acme/widgets"], { tag: "release/v1#1", action: "delete" }],
        ])
      }),
    ),
  )

  it.live("copilot_settings reports each section and explains the copilot scope for content exclusion", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/copilot/cloud-agent/configuration": {
            body: {
              mcp_configuration: { mcpServers: { db: { type: "local" } } },
              enabled_tools: {
                codeql: true,
                copilot_code_review: false,
                secret_scanning: true,
                dependency_vulnerability_checks: true,
              },
              require_actions_workflow_approval: true,
              is_firewall_enabled: true,
              is_firewall_recommended_allowlist_enabled: true,
              custom_allowlist: null,
              is_automations_enabled: false,
              require_write_access_for_automation_triggers: true,
            },
          },
          "GET /orgs/acme/copilot/coding-agent/permissions": { body: { enabled_repositories: "selected" } },
          "GET /orgs/acme/copilot/coding-agent/permissions/repositories": {
            body: { total_count: 2, repositories: [{ name: "api" }, { name: "Widgets" }] },
          },
          "GET /orgs/acme/copilot/billing": {
            body: { plan_type: "business", seat_breakdown: { total: 10, active_this_cycle: 7 } },
          },
          "GET /orgs/acme/copilot/content_exclusion": {
            status: 403,
            body: { message: "Resource not accessible by personal access token" },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run(find(GitHubAutomation.tools(deps), "copilot_settings"), { repo: "acme/widgets" })
        expect(result).toEqual({
          cloud_agent: {
            available: true,
            mcp_configuration: { mcpServers: { db: { type: "local" } } },
            enabled_tools: {
              codeql: true,
              copilot_code_review: false,
              secret_scanning: true,
              dependency_vulnerability_checks: true,
            },
            require_actions_workflow_approval: true,
            is_firewall_enabled: true,
            is_firewall_recommended_allowlist_enabled: true,
            is_automations_enabled: false,
            require_write_access_for_automation_triggers: true,
          },
          organization: {
            available: true,
            org: "acme",
            enabled_repositories: "selected",
            repository_enabled: true,
            plan_type: "business",
            seat_breakdown: { total: 10, active_this_cycle: 7 },
            notes: [],
          },
          content_exclusion: {
            available: false,
            reason:
              "Resource not accessible by personal access token (403). Reading content exclusion needs organization owner access and the copilot token scope: run `gh auth refresh -s copilot`.",
          },
          note: "Copilot code review on push is configured through rulesets (rule type copilot_code_review); see the rulesets tool.",
        })
      }),
    ),
  )

  it.live("copilot_settings degrades unreadable organization sections and reads content exclusion rules", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/copilot/cloud-agent/configuration": missing,
          "GET /orgs/acme/copilot/coding-agent/permissions": forbidden,
          "GET /orgs/acme/copilot/billing": missing,
          "GET /orgs/acme/copilot/content_exclusion": { body: { "*": ["**/.env"], widgets: ["secrets/**"] } },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubAutomation.tools(deps), "copilot_settings"), { repo: "acme/widgets" }),
        ).toMatchObject({
          cloud_agent: { available: false, reason: "Not Found (404)" },
          organization: {
            available: false,
            org: "acme",
            notes: ["cloud agent policy: Must have admin rights to Repository. (403)", "billing: Not Found (404)"],
          },
          content_exclusion: { available: true, rules: { "*": ["**/.env"], widgets: ["secrets/**"] } },
        })
        expect(calls(github.requests)).not.toContain("GET /orgs/acme/copilot/coding-agent/permissions/repositories")
      }),
    ),
  )

  it.live("copilot_settings_update writes organization endpoints and asks permission on the organization", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PUT /orgs/acme/copilot/coding-agent/permissions": { status: 204 },
          "GET /repos/acme/api": { body: { id: 11 } },
          "GET /repos/acme/web": { body: { id: 12 } },
          "PUT /orgs/acme/copilot/coding-agent/permissions/repositories/11": { status: 204 },
          "DELETE /orgs/acme/copilot/coding-agent/permissions/repositories/12": { status: 204 },
          "PUT /orgs/acme/copilot/content_exclusion": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAutomation.tools(deps), "copilot_settings_update")
        const empty = yield* run(tool, { org: "acme" }).pipe(Effect.flip)
        expect(String(empty.message)).toContain("Nothing to change")
        expect(
          yield* run(tool, {
            org: "acme",
            enabled_repositories: "selected",
            enable_repository: "api",
            disable_repository: "acme/web",
            content_exclusion: { "*": ["**/.env"] },
          }),
        ).toEqual({ changed: ["enabled_repositories", "enable_repository", "disable_repository", "content_exclusion"] })
        expect(writes(github.requests)).toEqual([
          {
            method: "PUT",
            path: "/orgs/acme/copilot/coding-agent/permissions",
            body: { enabled_repositories: "selected" },
          },
          { method: "PUT", path: "/orgs/acme/copilot/coding-agent/permissions/repositories/11", body: undefined },
          { method: "DELETE", path: "/orgs/acme/copilot/coding-agent/permissions/repositories/12", body: undefined },
          { method: "PUT", path: "/orgs/acme/copilot/content_exclusion", body: { "*": ["**/.env"] } },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_copilot_settings_update", ["github.com/acme/*"]],
        ])
      }),
    ),
  )
})
