import { describe, expect } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { GitHubAccess } from "../src/access.js"
import { it, tmpdirScoped, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run, type Request } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }
const forbidden = { status: 403, body: { message: "Must have admin rights to Repository." } }
const missing = { status: 404, body: { message: "Not Found" } }
const resource = ["github.com/acme/widgets"]

const writes = (requests: ReadonlyArray<Request>) =>
  requests
    .filter((request) => request.method !== "GET")
    .map((request) => ({ method: request.method, path: request.path, body: request.body }))

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyMaterialThatMustNotLeak0123456789 deploy@example"

describe("github access tools", () => {
  it.live("collaborators maps users, invitations and roles; a 404 teams section becomes a note", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/collaborators": {
            body: [
              {
                login: "alice",
                role_name: "admin",
                permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
              },
              { login: "bob", role_name: "release-manager" },
            ],
          },
          "GET /repos/acme/widgets/teams": missing,
          "GET /repos/acme/widgets/invitations": {
            body: [
              {
                id: 7,
                invitee: { login: "carol" },
                permissions: "write",
                created_at: "2026-01-02T00:00:00Z",
              },
              {
                id: 8,
                invitee: null,
                email: "dave@example.com",
                permissions: "read",
                created_at: "2026-01-03T00:00:00Z",
              },
            ],
          },
          "GET /orgs/acme/custom-repository-roles": {
            body: {
              total_count: 1,
              custom_roles: [
                { id: 3, name: "release-manager", base_role: "write", permissions: ["create_tag", "delete_tag"] },
              ],
            },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubAccess.tools(deps), "collaborators"), {
            repo: "acme/widgets",
            affiliation: "outside",
            roles: true,
          }),
        ).toEqual({
          users: [
            {
              login: "alice",
              role: "admin",
              permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
            },
            { login: "bob", role: "release-manager" },
          ],
          teams: [],
          invitations: [
            { id: 7, login: "carol", permission: "write", created_at: "2026-01-02T00:00:00Z" },
            { id: 8, email: "dave@example.com", permission: "read", created_at: "2026-01-03T00:00:00Z" },
          ],
          roles: [{ id: 3, name: "release-manager", base_role: "write", permissions: ["create_tag", "delete_tag"] }],
          notes: ["teams: not an organization repository, or not visible"],
        })
        expect(
          github.requests.find((request) => request.path === "/repos/acme/widgets/collaborators")?.query.affiliation,
        ).toBe("outside")
      }),
    ),
  )

  it.live("collaborators lists teams, skips roles unless asked, and turns a 403 into a note", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/collaborators": { body: [] },
          "GET /repos/acme/widgets/teams": { body: [{ slug: "core", name: "Core", permission: "maintain" }] },
          "GET /repos/acme/widgets/invitations": forbidden,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAccess.tools(deps), "collaborators"), { repo: "acme/widgets" })).toEqual({
          users: [],
          teams: [{ slug: "core", name: "Core", permission: "maintain" }],
          invitations: [],
          notes: ["invitations: requires admin access"],
        })
        expect(
          github.requests.find((request) => request.path === "/repos/acme/widgets/collaborators")?.query.affiliation,
        ).toBe("all")
        expect(github.requests.some((request) => request.path.includes("custom-repository-roles"))).toBe(false)
      }),
    ),
  )

  it.live("collaborator_update invites (201), updates (204), sets team permission, removes and cancels", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "PUT /repos/acme/widgets/collaborators/newbie": { status: 201, body: { id: 99 } },
          "PUT /repos/acme/widgets/collaborators/alice": { status: 204 },
          "PUT /orgs/acme/teams/core/repos/acme/widgets": { status: 204 },
          "DELETE /repos/acme/widgets/collaborators/bob": { status: 204 },
          "DELETE /orgs/acme/teams/old/repos/acme/widgets": { status: 204 },
          "DELETE /repos/acme/widgets/invitations/7": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAccess.tools(deps), "collaborator_update")
        expect(yield* run(tool, { repo: "acme/widgets", user: "newbie", permission: "triage" })).toEqual({
          action: "invited",
          user: "newbie",
          permission: "triage",
        })
        expect(yield* run(tool, { repo: "acme/widgets", user: "alice", permission: "release-manager" })).toEqual({
          action: "updated",
          user: "alice",
          permission: "release-manager",
        })
        expect(yield* run(tool, { repo: "acme/widgets", team: "core", permission: "maintain" })).toEqual({
          action: "updated",
          team: "core",
          permission: "maintain",
        })
        expect(yield* run(tool, { repo: "acme/widgets", user: "bob", remove: true })).toEqual({
          action: "removed",
          user: "bob",
        })
        expect(yield* run(tool, { repo: "acme/widgets", team: "old", remove: true })).toEqual({
          action: "removed",
          team: "old",
        })
        expect(yield* run(tool, { repo: "acme/widgets", invitation: 7 })).toEqual({
          action: "cancelled",
          invitation: 7,
        })
        expect(writes(github.requests)).toEqual([
          { method: "PUT", path: "/repos/acme/widgets/collaborators/newbie", body: { permission: "triage" } },
          { method: "PUT", path: "/repos/acme/widgets/collaborators/alice", body: { permission: "release-manager" } },
          { method: "PUT", path: "/orgs/acme/teams/core/repos/acme/widgets", body: { permission: "maintain" } },
          { method: "DELETE", path: "/repos/acme/widgets/collaborators/bob", body: undefined },
          { method: "DELETE", path: "/orgs/acme/teams/old/repos/acme/widgets", body: undefined },
          { method: "DELETE", path: "/repos/acme/widgets/invitations/7", body: undefined },
        ])
        expect(asserted.map((item) => [item.action, item.resources, item.metadata?.action])).toEqual([
          ["github_collaborator_update", resource, "set"],
          ["github_collaborator_update", resource, "set"],
          ["github_collaborator_update", resource, "set"],
          ["github_collaborator_update", resource, "remove"],
          ["github_collaborator_update", resource, "remove"],
          ["github_collaborator_update", resource, "cancel"],
        ])
      }),
    ),
  )

  it.live("collaborator_update rejects ambiguous subjects without a request or approval", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({})
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const failed = yield* run(find(GitHubAccess.tools(deps), "collaborator_update"), {
          repo: "acme/widgets",
          user: "alice",
          team: "core",
        }).pipe(Effect.flip)
        expect(failed.message).toContain("exactly one of user, team or invitation")
        expect(github.requests).toEqual([])
        expect(asserted).toEqual([])
      }),
    ),
  )

  it.live("properties returns values and the organization schema", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/properties/values": {
            body: [
              { property_name: "tier", value: "gold" },
              { property_name: "teams", value: ["sre", "ops"] },
              { property_name: "owner", value: null },
            ],
          },
          "GET /orgs/acme/properties/schema": {
            body: [
              {
                property_name: "tier",
                value_type: "single_select",
                required: true,
                default_value: "bronze",
                allowed_values: ["bronze", "gold"],
                description: "Support tier",
                values_editable_by: "org_actors",
              },
              { property_name: "owner", value_type: "string", required: false, default_value: null },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAccess.tools(deps), "properties"), { repo: "acme/widgets" })).toEqual({
          values: [
            { property_name: "tier", value: "gold" },
            { property_name: "teams", value: ["sre", "ops"] },
            { property_name: "owner", value: null },
          ],
          schema: [
            {
              property_name: "tier",
              value_type: "single_select",
              required: true,
              default_value: "bronze",
              allowed_values: ["bronze", "gold"],
              description: "Support tier",
              values_editable_by: "org_actors",
            },
            { property_name: "owner", value_type: "string", required: false, default_value: null },
          ],
          notes: [],
        })
      }),
    ),
  )

  it.live("properties omits the schema with a note when the organization answers 403", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/properties/values": { body: [{ property_name: "tier", value: "gold" }] },
          "GET /orgs/acme/properties/schema": forbidden,
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAccess.tools(deps), "properties"), { repo: "acme/widgets" })).toEqual({
          values: [{ property_name: "tier", value: "gold" }],
          notes: ["schema: requires admin access"],
        })
      }),
    ),
  )

  it.live("property_set PATCHes every value, null included", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({ "PATCH /repos/acme/widgets/properties/values": { status: 204 } })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        expect(
          yield* run(find(GitHubAccess.tools(deps), "property_set"), {
            repo: "acme/widgets",
            values: { tier: "gold", teams: ["sre", "ops"], owner: null },
          }),
        ).toEqual({ changed: ["tier", "teams", "owner"] })
        expect(writes(github.requests)).toEqual([
          {
            method: "PATCH",
            path: "/repos/acme/widgets/properties/values",
            body: {
              properties: [
                { property_name: "tier", value: "gold" },
                { property_name: "teams", value: ["sre", "ops"] },
                { property_name: "owner", value: null },
              ],
            },
          },
        ])
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([["github_property_set", resource]])
      }),
    ),
  )

  it.live("deploy_keys never returns the full key", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/keys": {
            body: [
              {
                id: 5,
                key: KEY,
                title: "ci",
                read_only: true,
                verified: true,
                created_at: "2026-01-01T00:00:00Z",
                last_used: "2026-02-01T00:00:00Z",
                added_by: "alice",
              },
              {
                id: 6,
                key: KEY,
                title: "old",
                read_only: false,
                verified: false,
                created_at: "2025-01-01T00:00:00Z",
                last_used: null,
              },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubAccess.tools(deps), "deploy_keys"), { repo: "acme/widgets" })
        expect(output).toEqual({
          keys: [
            {
              id: 5,
              title: "ci",
              read_only: true,
              verified: true,
              created_at: "2026-01-01T00:00:00Z",
              last_used: "2026-02-01T00:00:00Z",
              added_by: "alice",
              fingerprint_hint: "ssh-ed25519 AAAAC3Nz",
            },
            {
              id: 6,
              title: "old",
              read_only: false,
              verified: false,
              created_at: "2025-01-01T00:00:00Z",
              fingerprint_hint: "ssh-ed25519 AAAAC3Nz",
            },
          ],
        })
        expect(JSON.stringify(output)).not.toContain("ExampleKeyMaterial")
      }),
    ),
  )

  it.live("deploy_key_update reads from_file through the read approval, defaults read_only, and deletes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(() => writeFile(path.join(tmp.path, "deploy.pub"), `${KEY}\n`))
        const github = fakeGitHub({
          "POST /repos/acme/widgets/keys": { status: 201, body: { id: 42, title: "ci", key: KEY } },
          "DELETE /repos/acme/widgets/keys/6": { status: 204 },
        })
        const made = yield* makeDeps({ http: github.http, directory: tmp.path })
        const tool = find(GitHubAccess.tools(made.deps), "deploy_key_update")
        expect(yield* run(tool, { repo: "acme/widgets", title: "ci", from_file: "deploy.pub" })).toEqual({
          action: "added",
          id: 42,
          title: "ci",
        })
        expect(yield* run(tool, { repo: "acme/widgets", id: 6 })).toEqual({ action: "deleted", id: 6 })
        expect(made.approvals).toEqual([{ kind: "read", path: path.join(tmp.path, "deploy.pub") }])
        expect(writes(github.requests)).toEqual([
          { method: "POST", path: "/repos/acme/widgets/keys", body: { title: "ci", key: KEY, read_only: true } },
          { method: "DELETE", path: "/repos/acme/widgets/keys/6", body: undefined },
        ])
        expect(made.asserted.map((item) => [item.action, item.resources, item.metadata?.action])).toEqual([
          ["github_deploy_key_update", resource, "add"],
          ["github_deploy_key_update", resource, "delete"],
        ])
      }),
    ),
  )

  it.live("autolinks lists the repository's autolinks", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/autolinks": {
            body: [
              {
                id: 1,
                key_prefix: "TICKET-",
                url_template: "https://jira.example/browse/TICKET-<num>",
                is_alphanumeric: true,
              },
            ],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        expect(yield* run(find(GitHubAccess.tools(deps), "autolinks"), { repo: "acme/widgets" })).toEqual({
          autolinks: [
            {
              id: 1,
              key_prefix: "TICKET-",
              url_template: "https://jira.example/browse/TICKET-<num>",
              is_alphanumeric: true,
            },
          ],
        })
      }),
    ),
  )

  it.live("autolink_update creates with is_alphanumeric default true and deletes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "POST /repos/acme/widgets/autolinks": {
            status: 201,
            body: { id: 9, key_prefix: "OPS-", url_template: "https://ops.example/<num>", is_alphanumeric: true },
          },
          "DELETE /repos/acme/widgets/autolinks/1": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubAccess.tools(deps), "autolink_update")
        expect(
          yield* run(tool, { repo: "acme/widgets", key_prefix: "OPS-", url_template: "https://ops.example/<num>" }),
        ).toEqual({ action: "created", id: 9, key_prefix: "OPS-" })
        expect(yield* run(tool, { repo: "acme/widgets", id: 1 })).toEqual({ action: "deleted", id: 1 })
        expect(writes(github.requests)).toEqual([
          {
            method: "POST",
            path: "/repos/acme/widgets/autolinks",
            body: { key_prefix: "OPS-", url_template: "https://ops.example/<num>", is_alphanumeric: true },
          },
          { method: "DELETE", path: "/repos/acme/widgets/autolinks/1", body: undefined },
        ])
        expect(asserted.map((item) => [item.action, item.resources, item.metadata?.action])).toEqual([
          ["github_autolink_update", resource, "create"],
          ["github_autolink_update", resource, "delete"],
        ])
      }),
    ),
  )

  it.live("autolink_update rejects a template without <num> before any request or approval", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({})
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const failed = yield* run(find(GitHubAccess.tools(deps), "autolink_update"), {
          repo: "acme/widgets",
          key_prefix: "OPS-",
          url_template: "https://ops.example/{id}",
        }).pipe(Effect.flip)
        expect(failed.message).toContain('url_template must contain "<num>"')
        expect(github.requests).toEqual([])
        expect(asserted).toEqual([])
      }),
    ),
  )
})
