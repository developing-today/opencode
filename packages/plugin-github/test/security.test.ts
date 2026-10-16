import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { GitHubSecurity } from "../src/security.js"
import { it, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Request } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }
const forbidden = { status: 403, body: { message: "Must have admin rights to Repository." } }
const missing = { status: 404, body: { message: "Not Found" } }
const repo = "acme/widgets"

const writes = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.method !== "GET")
    .map((request) => ({ method: request.method, path: request.path, body: request.body }))

const alertList = (count: number, next: boolean) => ({
  body: Array.from({ length: count }, (_, index) => ({ number: index + 1 })),
  ...(next
    ? { headers: { link: '<https://api.github.com/repositories/1/dependabot/alerts?page=2>; rel="next"' } }
    : {}),
})

describe("github security tools", () => {
  it.live("security reads every part for an admin and counts open alerts", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets": {
            body: {
              full_name: "acme/widgets",
              security_and_analysis: {
                advanced_security: { status: "enabled" },
                secret_scanning: { status: "enabled" },
                secret_scanning_push_protection: { status: "disabled" },
                dependabot_security_updates: { status: "enabled" },
                secret_scanning_delegated_bypass: { status: "disabled" },
              },
            },
          },
          "GET /repos/acme/widgets/vulnerability-alerts": { status: 204 },
          "GET /repos/acme/widgets/automated-security-fixes": { body: { enabled: true, paused: false } },
          "GET /repos/acme/widgets/private-vulnerability-reporting": { body: { enabled: false } },
          "GET /repos/acme/widgets/code-scanning/default-setup": {
            body: {
              state: "configured",
              languages: ["javascript-typescript", "actions"],
              query_suite: "extended",
              updated_at: "2026-09-01T00:00:00Z",
              schedule: "weekly",
            },
          },
          "GET /repos/acme/widgets/code-security-configuration": {
            body: { status: "enforced", configuration: { id: 17, name: "Org default", description: "x" } },
          },
          "GET /repos/acme/widgets/dependabot/alerts": alertList(100, true),
          "GET /repos/acme/widgets/code-scanning/alerts": alertList(3, false),
          "GET /repos/acme/widgets/secret-scanning/alerts": missing,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubSecurity.tools(deps), "security"), { repo })).toEqual({
          repo: "acme/widgets",
          security_and_analysis: {
            advanced_security: "enabled",
            secret_scanning: "enabled",
            secret_scanning_push_protection: "disabled",
            dependabot_security_updates: "enabled",
            secret_scanning_delegated_bypass: "disabled",
          },
          dependabot_alerts: { enabled: true },
          dependabot_security_updates: { enabled: true, paused: false },
          private_vulnerability_reporting: { enabled: false },
          code_scanning_default_setup: {
            state: "configured",
            languages: ["javascript-typescript", "actions"],
            query_suite: "extended",
            updated_at: "2026-09-01T00:00:00Z",
            schedule: "weekly",
          },
          code_security_configuration: { status: "enforced", configuration: { id: 17, name: "Org default" } },
          open_alerts: {
            dependabot: "100+",
            code_scanning: 3,
            secret_scanning: { available: false, reason: "not enabled or requires security access" },
          },
        })
        const counts = github.requests.filter((request) => request.path.endsWith("/alerts"))
        expect(counts.map((request) => [request.path, request.query])).toEqual(
          expect.arrayContaining([
            ["/repos/acme/widgets/dependabot/alerts", { state: "open", per_page: "100" }],
            ["/repos/acme/widgets/code-scanning/alerts", { state: "open", per_page: "100" }],
            ["/repos/acme/widgets/secret-scanning/alerts", { state: "open", per_page: "100", hide_secret: "true" }],
          ]),
        )
      }),
    ),
  )

  it.live("security for a non-admin: hidden security_and_analysis, an unknowable alerts setting, 403s degrade", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets": { body: { full_name: "acme/widgets" } },
          "GET /repos/acme/widgets/vulnerability-alerts": missing,
          "GET /repos/acme/widgets/automated-security-fixes": forbidden,
          "GET /repos/acme/widgets/private-vulnerability-reporting": missing,
          "GET /repos/acme/widgets/code-scanning/default-setup": forbidden,
          "GET /repos/acme/widgets/code-security-configuration": { status: 204 },
          "GET /repos/acme/widgets/dependabot/alerts": forbidden,
          "GET /repos/acme/widgets/code-scanning/alerts": alertList(0, false),
          "GET /repos/acme/widgets/secret-scanning/alerts": alertList(2, false),
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubSecurity.tools(deps), "security"), { repo })).toEqual({
          repo: "acme/widgets",
          security_and_analysis: { available: false, reason: "requires admin access" },
          // GitHub answers 404 to non-admins whether or not alerts are on.
          dependabot_alerts: { available: false, reason: "requires admin or security access" },
          dependabot_security_updates: { available: false, reason: "requires admin or security access" },
          private_vulnerability_reporting: {
            available: false,
            reason: "not enabled or not visible to this account",
          },
          code_scanning_default_setup: { available: false, reason: "requires admin or security access" },
          code_security_configuration: { status: "none" },
          open_alerts: {
            dependabot: { available: false, reason: "requires admin or security access" },
            code_scanning: 0,
            secret_scanning: 2,
          },
        })
      }),
    ),
  )

  it.live("security for an admin reads a 404 from the Dependabot alerts check as disabled", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets": { body: { full_name: "acme/widgets", permissions: { admin: true } } },
          "GET /repos/acme/widgets/vulnerability-alerts": missing,
          "GET /repos/acme/widgets/automated-security-fixes": missing,
          "GET /repos/acme/widgets/private-vulnerability-reporting": missing,
          "GET /repos/acme/widgets/code-scanning/default-setup": missing,
          "GET /repos/acme/widgets/code-security-configuration": missing,
          "GET /repos/acme/widgets/dependabot/alerts": missing,
          "GET /repos/acme/widgets/code-scanning/alerts": missing,
          "GET /repos/acme/widgets/secret-scanning/alerts": missing,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run<object, { dependabot_alerts: unknown }>(
          find(GitHubSecurity.tools(deps), "security"),
          {
            repo,
          },
        )
        expect(output.dependabot_alerts).toEqual({ enabled: false })
      }),
    ),
  )

  it.live("security_update sends one security_and_analysis PATCH plus the separate toggle endpoints", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PATCH /repos/acme/widgets": { body: {} },
          "PUT /repos/acme/widgets/vulnerability-alerts": { status: 204 },
          "PUT /repos/acme/widgets/automated-security-fixes": { status: 204 },
          "DELETE /repos/acme/widgets/private-vulnerability-reporting": { status: 204 },
          "PATCH /repos/acme/widgets/code-scanning/default-setup": { status: 202, body: { run_id: 1 } },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubSecurity.tools(deps), "security_update"), {
          repo,
          advanced_security: true,
          secret_scanning: true,
          secret_scanning_push_protection: false,
          dependabot_alerts: true,
          dependabot_security_updates: true,
          private_vulnerability_reporting: false,
          code_scanning_default_setup: "configured",
          query_suite: "extended",
        })
        expect(output).toEqual({
          changed: [
            "advanced_security",
            "secret_scanning",
            "secret_scanning_push_protection",
            "dependabot_alerts",
            "dependabot_security_updates",
            "private_vulnerability_reporting",
            "code_scanning_default_setup",
            "query_suite",
          ],
        })
        expect(writes(github.requests)).toEqual([
          {
            method: "PATCH",
            path: "/repos/acme/widgets",
            body: {
              security_and_analysis: {
                advanced_security: { status: "enabled" },
                secret_scanning: { status: "enabled" },
                secret_scanning_push_protection: { status: "disabled" },
              },
            },
          },
          { method: "PUT", path: "/repos/acme/widgets/vulnerability-alerts", body: undefined },
          { method: "PUT", path: "/repos/acme/widgets/automated-security-fixes", body: undefined },
          { method: "DELETE", path: "/repos/acme/widgets/private-vulnerability-reporting", body: undefined },
          {
            method: "PATCH",
            path: "/repos/acme/widgets/code-scanning/default-setup",
            body: { state: "configured", query_suite: "extended" },
          },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["github_security_update", ["github.com/acme/widgets"]],
        ])
      }),
    ),
  )

  it.live("security_update disables security updates before alerts and skips the PATCH when unneeded", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "DELETE /repos/acme/widgets/vulnerability-alerts": { status: 204 },
          "DELETE /repos/acme/widgets/automated-security-fixes": { status: 204 },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubSecurity.tools(deps), "security_update"), {
            repo,
            dependabot_alerts: false,
            dependabot_security_updates: false,
          }),
        ).toEqual({ changed: ["dependabot_alerts", "dependabot_security_updates"] })
        expect(writes(github.requests)).toEqual([
          { method: "DELETE", path: "/repos/acme/widgets/automated-security-fixes", body: undefined },
          { method: "DELETE", path: "/repos/acme/widgets/vulnerability-alerts", body: undefined },
        ])
      }),
    ),
  )

  it.live("security_update refuses an empty change without asking or sending anything", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({})
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const failed = yield* run(find(GitHubSecurity.tools(deps), "security_update"), { repo }).pipe(Effect.flip)
        expect(String(failed.message)).toContain("Nothing to change")
        expect(github.requests).toEqual([])
        expect(asserted).toEqual([])
      }),
    ),
  )

  it.live("alerts dependabot maps advisories and passes filters as query parameters", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/dependabot/alerts": {
            body: [
              {
                number: 7,
                state: "dismissed",
                created_at: "2026-08-01T00:00:00Z",
                html_url: "https://github.com/acme/widgets/security/dependabot/7",
                dismissed_reason: "tolerable_risk",
                dismissed_comment: "dev only",
                dependency: {
                  package: { ecosystem: "npm", name: "lodash" },
                  manifest_path: "package-lock.json",
                  scope: "development",
                },
                security_advisory: { summary: "Prototype pollution in lodash", severity: "high" },
                security_vulnerability: { severity: "critical" },
              },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubSecurity.tools(deps), "alerts"), {
            repo,
            kind: "dependabot",
            state: "dismissed",
            severity: "critical",
            ecosystem: "npm",
            package: "lodash",
            scope: "development",
            limit: 5,
          }),
        ).toEqual({
          kind: "dependabot",
          total: 1,
          items: [
            {
              number: 7,
              state: "dismissed",
              severity: "critical",
              title: "Prototype pollution in lodash",
              package: "lodash",
              ecosystem: "npm",
              manifest: "package-lock.json",
              scope: "development",
              created_at: "2026-08-01T00:00:00Z",
              url: "https://github.com/acme/widgets/security/dependabot/7",
              dismissed_reason: "tolerable_risk",
              comment: "dev only",
            },
          ],
        })
        expect(github.requests.map((request) => request.query)).toEqual([
          {
            per_page: "6",
            state: "dismissed",
            severity: "critical",
            ecosystem: "npm",
            package: "lodash",
            scope: "development",
          },
        ])
      }),
    ),
  )

  it.live("alerts code_scanning maps rule, location and tool; reports N+ past the limit", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const alert = (number: number) => ({
          number,
          state: "open",
          created_at: `2026-09-0${number}T00:00:00Z`,
          html_url: `https://github.com/acme/widgets/security/code-scanning/${number}`,
          rule: {
            id: "js/sql-injection",
            description: "SQL injection",
            severity: "error",
            security_severity_level: "high",
          },
          tool: { name: "CodeQL" },
          most_recent_instance: { location: { path: "src/db.ts", start_line: 40 + number } },
        })
        const github = fakeGitHub({
          "GET /repos/acme/widgets/code-scanning/alerts": { body: [alert(1), alert(2), alert(3)] },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubSecurity.tools(deps), "alerts"), {
            repo,
            kind: "code_scanning",
            severity: "high",
            tool: "CodeQL",
            ref: "refs/heads/main",
            limit: 2,
          }),
        ).toEqual({
          kind: "code_scanning",
          total: "2+",
          items: [1, 2].map((number) => ({
            number,
            state: "open",
            severity: "high",
            title: "SQL injection",
            rule: "js/sql-injection",
            tool: "CodeQL",
            path: "src/db.ts",
            line: 40 + number,
            created_at: `2026-09-0${number}T00:00:00Z`,
            url: `https://github.com/acme/widgets/security/code-scanning/${number}`,
          })),
        })
        expect(github.requests.map((request) => request.query)).toEqual([
          { per_page: "3", state: "open", severity: "high", tool_name: "CodeQL", ref: "refs/heads/main" },
        ])
      }),
    ),
  )

  it.live("alerts secret_scanning never returns the secret value", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const leaked = "ghp_SUPERSECRETVALUE1234567890"
        const github = fakeGitHub({
          "GET /repos/acme/widgets/secret-scanning/alerts": {
            body: [
              {
                number: 3,
                state: "resolved",
                created_at: "2026-07-01T00:00:00Z",
                html_url: "https://github.com/acme/widgets/security/secret-scanning/3",
                secret_type: "github_personal_access_token",
                secret_type_display_name: "GitHub Personal Access Token",
                secret: leaked,
                validity: "inactive",
                resolution: "revoked",
                resolution_comment: "rotated",
                first_location_detected: { path: ".env", start_line: 2 },
              },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubSecurity.tools(deps), "alerts"), {
          repo,
          kind: "secret_scanning",
          state: "resolved",
          secret_type: "github_personal_access_token",
          validity: "inactive",
        })
        expect(JSON.stringify(output)).not.toContain(leaked)
        expect(output).toEqual({
          kind: "secret_scanning",
          total: 1,
          items: [
            {
              number: 3,
              state: "resolved",
              title: "GitHub Personal Access Token",
              secret_type: "github_personal_access_token",
              validity: "inactive",
              path: ".env",
              line: 2,
              created_at: "2026-07-01T00:00:00Z",
              url: "https://github.com/acme/widgets/security/secret-scanning/3",
              resolution: "revoked",
              comment: "rotated",
            },
          ],
        })
        expect(github.requests.map((request) => request.query)).toEqual([
          {
            per_page: "31",
            state: "resolved",
            secret_type: "github_personal_access_token",
            validity: "inactive",
            hide_secret: "true",
          },
        ])
      }),
    ),
  )

  it.live("alerts degrades a 404 kind and refuses filters from another kind without a request", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({ "GET /repos/acme/widgets/code-scanning/alerts": missing })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSecurity.tools(deps), "alerts")
        expect(yield* run(tool, { repo, kind: "code_scanning" })).toEqual({
          kind: "code_scanning",
          available: false,
          reason: "not enabled or requires security access",
        })
        const before = github.requests.length
        const stray = yield* run(tool, { repo, kind: "secret_scanning", ecosystem: "npm" }).pipe(Effect.flip)
        expect(String(stray.message)).toContain("ecosystem do not apply to secret_scanning alerts")
        const severity = yield* run(tool, { repo, kind: "secret_scanning", severity: "high" }).pipe(Effect.flip)
        expect(String(severity.message)).toContain("secret_scanning alerts have no severity filter")
        const state = yield* run(tool, { repo, kind: "dependabot", state: "resolved" }).pipe(Effect.flip)
        expect(String(state.message)).toContain("state for dependabot must be one of")
        expect(github.requests.length).toBe(before)
      }),
    ),
  )

  it.live("alert_update patches each kind with its own fields and asks permission per write", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PATCH /repos/acme/widgets/dependabot/alerts/7": { body: { number: 7, state: "dismissed" } },
          "PATCH /repos/acme/widgets/code-scanning/alerts/12": { body: { number: 12, state: "dismissed" } },
          "PATCH /repos/acme/widgets/secret-scanning/alerts/3": { body: { number: 3, state: "resolved" } },
          "PATCH /repos/acme/widgets/code-scanning/alerts/13": { body: { number: 13, state: "open" } },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSecurity.tools(deps), "alert_update")
        const long = "x".repeat(300)
        expect(
          yield* run(tool, { repo, kind: "dependabot", number: 7, state: "dismissed", reason: "not_used" }),
        ).toEqual({ kind: "dependabot", number: 7, state: "dismissed" })
        expect(
          yield* run(tool, {
            repo,
            kind: "code_scanning",
            number: 12,
            state: "dismissed",
            reason: "used in tests",
            comment: long,
          }),
        ).toEqual({ kind: "code_scanning", number: 12, state: "dismissed" })
        expect(
          yield* run(tool, {
            repo,
            kind: "secret_scanning",
            number: 3,
            state: "resolved",
            reason: "revoked",
            comment: "rotated",
          }),
        ).toEqual({ kind: "secret_scanning", number: 3, state: "resolved" })
        expect(yield* run(tool, { repo, kind: "code_scanning", number: 13, state: "open" })).toEqual({
          kind: "code_scanning",
          number: 13,
          state: "open",
        })
        expect(writes(github.requests)).toEqual([
          {
            method: "PATCH",
            path: "/repos/acme/widgets/dependabot/alerts/7",
            body: { state: "dismissed", dismissed_reason: "not_used" },
          },
          {
            method: "PATCH",
            path: "/repos/acme/widgets/code-scanning/alerts/12",
            body: { state: "dismissed", dismissed_reason: "used in tests", dismissed_comment: "x".repeat(280) },
          },
          {
            method: "PATCH",
            path: "/repos/acme/widgets/secret-scanning/alerts/3",
            body: { state: "resolved", resolution: "revoked", resolution_comment: "rotated" },
          },
          { method: "PATCH", path: "/repos/acme/widgets/code-scanning/alerts/13", body: { state: "open" } },
        ])
        expect(asserted.map((item) => [item.action, item.resources, item.metadata])).toEqual([
          [
            "github_alert_update",
            ["github.com/acme/widgets"],
            { kind: "dependabot", number: 7, state: "dismissed", reason: "not_used" },
          ],
          [
            "github_alert_update",
            ["github.com/acme/widgets"],
            { kind: "code_scanning", number: 12, state: "dismissed", reason: "used in tests" },
          ],
          [
            "github_alert_update",
            ["github.com/acme/widgets"],
            { kind: "secret_scanning", number: 3, state: "resolved", reason: "revoked" },
          ],
          ["github_alert_update", ["github.com/acme/widgets"], { kind: "code_scanning", number: 13, state: "open" }],
        ])
      }),
    ),
  )

  it.live("alert_update refuses mismatched kind, state and reason before any request or permission", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({})
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubSecurity.tools(deps), "alert_update")
        const cases = [
          [{ kind: "secret_scanning", state: "dismissed", reason: "revoked" }, 'close with state "resolved"'],
          [{ kind: "dependabot", state: "resolved", reason: "not_used" }, 'close with state "dismissed"'],
          [{ kind: "code_scanning", state: "dismissed", reason: "false_positive" }, "reason for code_scanning"],
          [{ kind: "dependabot", state: "dismissed" }, "reason for dependabot"],
          [{ kind: "secret_scanning", state: "open", reason: "revoked" }, "only apply when closing"],
        ] as const
        for (const [input, message] of cases) {
          const failed = yield* run(tool, { repo, number: 1, ...input }).pipe(Effect.flip)
          expect(String(failed.message)).toContain(message)
        }
        expect(github.requests).toEqual([])
        expect(asserted).toEqual([])
      }),
    ),
  )

  it.live("tools are ordered with short first description lines", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { deps } = yield* makeDeps({ http: fakeGitHub({}).http })
        const tools = GitHubSecurity.tools(deps)
        expect(tools.map((tool) => tool.name)).toEqual(["security", "security_update", "alerts", "alert_update"])
        expect(tools.filter((tool) => tool.description.split("\n")[0].length > 120).map((tool) => tool.name)).toEqual(
          [],
        )
      }),
    ),
  )
})
