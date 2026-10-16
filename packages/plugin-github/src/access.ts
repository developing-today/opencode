export * as GitHubAccess from "./access.js"

import { readFile } from "node:fs/promises"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

const Opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const StringList = Schema.Array(Schema.String)
const PropertyValue = Schema.NullOr(Schema.Union([Schema.String, StringList]))
const enc = encodeURIComponent

const invalid = (message: string, hint?: string) =>
  new GitHubClient.Error({ kind: "validation", message, ...(hint ? { hint } : {}) })

const soft = (error: GitHubClient.Error) => error.kind === "forbidden" || error.kind === "not_found"

interface Section<A> {
  readonly items: ReadonlyArray<A>
  readonly note?: string
}

// Access endpoints answer 403 or 404 without admin access (or on user-owned repositories); those become notes.
const section = <A>(
  label: string,
  effect: Effect.Effect<ReadonlyArray<A>, GitHubClient.Error>,
  missing = "not found or requires admin access",
) =>
  effect.pipe(
    Effect.map((items): Section<A> => ({ items })),
    Effect.catchIf(soft, (error) =>
      Effect.succeed<Section<A>>({
        items: [],
        note: `${label}: ${error.kind === "forbidden" ? "requires admin access" : missing}`,
      }),
    ),
  )

const notes = (sections: ReadonlyArray<Section<unknown> | undefined>) =>
  sections.flatMap((item) => (item?.note === undefined ? [] : [item.note]))

const Permissions = Schema.Struct({
  admin: Opt(Schema.Boolean),
  maintain: Opt(Schema.Boolean),
  push: Opt(Schema.Boolean),
  triage: Opt(Schema.Boolean),
  pull: Opt(Schema.Boolean),
})

interface CollaboratorData {
  readonly login: string
  readonly role_name?: string
  readonly permissions?: {
    readonly admin?: boolean
    readonly maintain?: boolean
    readonly push?: boolean
    readonly triage?: boolean
    readonly pull?: boolean
  }
}

interface TeamData {
  readonly slug: string
  readonly name: string
  readonly permission: string
}

interface InvitationData {
  readonly id: number
  readonly invitee?: { readonly login: string } | null
  readonly email?: string | null
  readonly permissions: string
  readonly created_at: string
}

interface RoleData {
  readonly id: number
  readonly name: string
  readonly base_role: string
  readonly permissions?: ReadonlyArray<string>
}

interface PropertySchemaData {
  readonly property_name: string
  readonly value_type: string
  readonly required?: boolean
  readonly default_value?: string | ReadonlyArray<string> | null
  readonly allowed_values?: ReadonlyArray<string> | null
  readonly description?: string | null
  readonly values_editable_by?: string | null
}

interface DeployKeyData {
  readonly id: number
  readonly key: string
  readonly title: string
  readonly read_only: boolean
  readonly verified: boolean
  readonly created_at: string
  readonly last_used?: string | null
  readonly added_by?: string | null
}

interface AutolinkData {
  readonly id: number
  readonly key_prefix: string
  readonly url_template: string
  readonly is_alphanumeric: boolean
}

const Autolink = Schema.Struct({
  id: Schema.Int,
  key_prefix: Schema.String,
  url_template: Schema.String,
  is_alphanumeric: Schema.Boolean,
})

export function tools(deps: GitHubShared.Deps): Tool.Info[] {
  const collaborators = GitHubShared.define(deps, {
    name: "collaborators",
    description: [
      "Who has access to a repository and how: users with their role, teams, and pending invitations.",
      "roles: true also lists the organization's custom repository roles. Sections the account cannot read become notes.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      affiliation: Opt(Schema.Literals(["all", "direct", "outside"])).annotate({
        description: 'Which users: "all" (default, includes organization members via teams), "direct" or "outside".',
      }),
      roles: Opt(Schema.Boolean).annotate({ description: "Also list the organization's custom repository roles." }),
    }),
    output: Schema.Struct({
      users: Schema.Array(
        Schema.Struct({ login: Schema.String, role: Opt(Schema.String), permissions: Opt(Permissions) }),
      ),
      teams: Schema.Array(Schema.Struct({ slug: Schema.String, name: Schema.String, permission: Schema.String })),
      invitations: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          login: Opt(Schema.String),
          email: Opt(Schema.String),
          permission: Schema.String,
          created_at: Schema.String,
        }),
      ),
      roles: Opt(
        Schema.Array(
          Schema.Struct({ id: Schema.Int, name: Schema.String, base_role: Schema.String, permissions: StringList }),
        ),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const [users, teams, invitations, roles] = yield* Effect.all(
          [
            section(
              "collaborators",
              api.paginate<CollaboratorData>(`/repos/${slug}/collaborators`, {
                query: { affiliation: input.affiliation ?? "all" },
              }),
            ),
            section(
              "teams",
              api.paginate<TeamData>(`/repos/${slug}/teams`),
              "not an organization repository, or not visible",
            ),
            section("invitations", api.paginate<InvitationData>(`/repos/${slug}/invitations`)),
            input.roles
              ? section(
                  "custom roles",
                  api.paginate<RoleData>(`/orgs/${enc(resolved.repo.owner)}/custom-repository-roles`, {
                    key: "custom_roles",
                  }),
                  "not an organization, or custom roles are unavailable",
                )
              : Effect.succeed(undefined),
          ],
          { concurrency: 4 },
        )
        return {
          users: users.items.map((user) => ({
            login: user.login,
            ...(user.role_name ? { role: user.role_name } : {}),
            ...(user.permissions ? { permissions: user.permissions } : {}),
          })),
          teams: teams.items.map((team) => ({ slug: team.slug, name: team.name, permission: team.permission })),
          invitations: invitations.items.map((invitation) => ({
            id: invitation.id,
            ...(invitation.invitee ? { login: invitation.invitee.login } : {}),
            ...(invitation.email ? { email: invitation.email } : {}),
            permission: invitation.permissions,
            created_at: invitation.created_at,
          })),
          ...(roles
            ? {
                roles: roles.items.map((role) => ({
                  id: role.id,
                  name: role.name,
                  base_role: role.base_role,
                  permissions: [...(role.permissions ?? [])],
                })),
              }
            : {}),
          notes: notes([users, teams, invitations, roles]),
        }
      }),
  })

  const collaboratorUpdate = GitHubShared.define(deps, {
    name: "collaborator_update",
    description: [
      "Grant, change or remove a user's or team's repository access, or cancel a pending invitation.",
      "Adding a user who is not yet a collaborator sends an invitation. Teams are slugs in the repository owner's organization.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      user: Opt(Schema.String).annotate({ description: "User login." }),
      team: Opt(Schema.String).annotate({ description: "Team slug." }),
      permission: Opt(Schema.String).annotate({
        description: 'pull, triage, push, maintain, admin, or a custom role name. GitHub defaults to "push".',
      }),
      remove: Opt(Schema.Boolean).annotate({ description: "Remove the user's or team's access." }),
      invitation: Opt(Schema.Int).annotate({ description: "Pending invitation id to cancel." }),
    }),
    output: Schema.Struct({
      action: Schema.Literals(["invited", "updated", "removed", "cancelled"]),
      user: Opt(Schema.String),
      team: Opt(Schema.String),
      permission: Opt(Schema.String),
      invitation: Opt(Schema.Int),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const subjects = [input.user, input.team, input.invitation].filter((item) => item !== undefined).length
        if (subjects !== 1) return yield* invalid("Pass exactly one of user, team or invitation.")
        if (input.remove && input.permission !== undefined)
          return yield* invalid("permission does not apply when removing.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const action = input.invitation !== undefined ? "cancel" : input.remove ? "remove" : "set"
        yield* GitHubShared.authorize(deps, context, "collaborator_update", resolved.repo, {
          ...(input.user === undefined ? {} : { user: input.user }),
          ...(input.team === undefined ? {} : { team: input.team }),
          ...(input.invitation === undefined ? {} : { invitation: input.invitation }),
          ...(input.permission === undefined ? {} : { permission: input.permission }),
          action,
        })
        if (input.invitation !== undefined) {
          yield* api.request("DELETE", `/repos/${slug}/invitations/${input.invitation}`)
          return { action: "cancelled" as const, invitation: input.invitation }
        }
        const permission = input.permission === undefined ? {} : { permission: input.permission }
        if (input.team !== undefined) {
          const path = `/orgs/${enc(resolved.repo.owner)}/teams/${enc(input.team)}/repos/${slug}`
          if (input.remove) {
            yield* api.request("DELETE", path)
            return { action: "removed" as const, team: input.team }
          }
          yield* api.request("PUT", path, { body: permission })
          return { action: "updated" as const, team: input.team, ...permission }
        }
        const user = input.user ?? ""
        const path = `/repos/${slug}/collaborators/${enc(user)}`
        if (input.remove) {
          yield* api.request("DELETE", path)
          return { action: "removed" as const, user }
        }
        const response = yield* api.request("PUT", path, { body: permission })
        // 201 means GitHub created an invitation; 204 means an existing collaborator's permission changed.
        return { action: response.status === 201 ? ("invited" as const) : ("updated" as const), user, ...permission }
      }),
  })

  const properties = GitHubShared.define(deps, {
    name: "properties",
    description: [
      "Custom property values of a repository, plus the organization's property definitions when visible.",
      "Sections the account cannot read become notes.",
    ].join("\n"),
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({
      values: Schema.Array(Schema.Struct({ property_name: Schema.String, value: PropertyValue })),
      schema: Opt(
        Schema.Array(
          Schema.Struct({
            property_name: Schema.String,
            value_type: Schema.String,
            required: Opt(Schema.Boolean),
            default_value: Opt(PropertyValue),
            allowed_values: Opt(Schema.NullOr(StringList)),
            description: Opt(Schema.NullOr(Schema.String)),
            values_editable_by: Opt(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const [values, schema] = yield* Effect.all(
          [
            section(
              "values",
              api.json<ReadonlyArray<{ property_name: string; value: string | ReadonlyArray<string> | null }>>(
                "GET",
                `/repos/${GitHubRepo.slug(resolved.repo)}/properties/values`,
              ),
            ),
            section(
              "schema",
              api.json<ReadonlyArray<PropertySchemaData>>("GET", `/orgs/${enc(resolved.repo.owner)}/properties/schema`),
              "not an organization repository, or not visible",
            ),
          ],
          { concurrency: 2 },
        )
        return {
          values: values.items.map((item) => ({ property_name: item.property_name, value: item.value ?? null })),
          ...(schema.note === undefined
            ? {
                schema: schema.items.map((item) => ({
                  property_name: item.property_name,
                  value_type: item.value_type,
                  ...(item.required === undefined ? {} : { required: item.required }),
                  ...(item.default_value === undefined ? {} : { default_value: item.default_value }),
                  ...(item.allowed_values === undefined ? {} : { allowed_values: item.allowed_values }),
                  ...(item.description === undefined ? {} : { description: item.description }),
                  ...(item.values_editable_by === undefined ? {} : { values_editable_by: item.values_editable_by }),
                })),
              }
            : {}),
          notes: notes([values, schema]),
        }
      }),
  })

  const propertySet = GitHubShared.define(deps, {
    name: "property_set",
    description: [
      "Set or clear custom property values on a repository.",
      "values maps property name to a string, a list of strings (multi_select), or null to clear.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      values: Schema.Record(Schema.String, PropertyValue),
    }),
    output: Schema.Struct({ changed: StringList }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const changed = Object.keys(input.values)
        if (changed.length === 0) return yield* invalid("Nothing to change; pass at least one property.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        yield* GitHubShared.authorize(deps, context, "property_set", resolved.repo, { changed })
        yield* resolved.api.request("PATCH", `/repos/${GitHubRepo.slug(resolved.repo)}/properties/values`, {
          body: {
            properties: Object.entries(input.values).map(([name, value]) => ({ property_name: name, value })),
          },
        })
        return { changed }
      }),
  })

  const deployKeys = GitHubShared.define(deps, {
    name: "deploy_keys",
    description: [
      "Deploy keys of a repository: title, read-only, verified, created and last used.",
      "Key material is never returned beyond its first 20 characters (fingerprint_hint).",
    ].join("\n"),
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({
      keys: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          title: Schema.String,
          read_only: Schema.Boolean,
          verified: Schema.Boolean,
          created_at: Schema.String,
          last_used: Opt(Schema.String),
          added_by: Opt(Schema.String),
          fingerprint_hint: Schema.String,
        }),
      ),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const keys = yield* resolved.api.paginate<DeployKeyData>(`/repos/${GitHubRepo.slug(resolved.repo)}/keys`)
        return {
          keys: keys.map((key) => ({
            id: key.id,
            title: key.title,
            read_only: key.read_only,
            verified: key.verified,
            created_at: key.created_at,
            ...(key.last_used ? { last_used: key.last_used } : {}),
            ...(key.added_by ? { added_by: key.added_by } : {}),
            fingerprint_hint: key.key.slice(0, 20),
          })),
        }
      }),
  })

  const deployKeyUpdate = GitHubShared.define(deps, {
    name: "deploy_key_update",
    description: [
      "Add a deploy key to a repository (read-only by default), or delete one by id.",
      "Pass the public key as key, or from_file with a local .pub path.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      title: Opt(Schema.String).annotate({ description: "Required when adding." }),
      key: Opt(Schema.String).annotate({ description: "Public key text." }),
      from_file: Opt(Schema.String).annotate({ description: "Local file holding the public key." }),
      read_only: Opt(Schema.Boolean).annotate({ description: "Default true. False grants push access." }),
      id: Opt(Schema.Int).annotate({ description: "Deploy key to delete." }),
    }),
    output: Schema.Struct({
      action: Schema.Literals(["added", "deleted"]),
      id: Schema.Int,
      title: Opt(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const adding = input.title !== undefined || input.key !== undefined || input.from_file !== undefined
        if (input.id !== undefined && adding) return yield* invalid("Pass id to delete, or title and key to add.")
        if (input.id === undefined && input.title === undefined) return yield* invalid("Adding needs title.")
        if (input.id === undefined && (input.key === undefined) === (input.from_file === undefined))
          return yield* invalid("Pass exactly one of key or from_file.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/keys`
        if (input.id !== undefined) {
          yield* GitHubShared.authorize(deps, context, "deploy_key_update", resolved.repo, {
            id: input.id,
            action: "delete",
          })
          yield* resolved.api.request("DELETE", `${base}/${input.id}`)
          return { action: "deleted" as const, id: input.id }
        }
        const text =
          input.from_file !== undefined
            ? yield* GitHubShared.readable(deps, context, input.from_file).pipe(
                Effect.flatMap((file) =>
                  Effect.tryPromise({
                    try: () => readFile(file, "utf8"),
                    catch: (cause) =>
                      invalid(
                        `Unable to read ${input.from_file}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
                      ),
                  }),
                ),
              )
            : (input.key ?? "")
        const key = text.trim()
        if (key === "") return yield* invalid("The public key is empty.")
        const readOnly = input.read_only ?? true
        yield* GitHubShared.authorize(deps, context, "deploy_key_update", resolved.repo, {
          title: input.title,
          read_only: readOnly,
          action: "add",
        })
        const created = yield* resolved.api.json<{ id: number; title: string }>("POST", base, {
          body: { title: input.title, key, read_only: readOnly },
        })
        return { action: "added" as const, id: created.id, title: created.title }
      }),
  })

  const autolinks = GitHubShared.define(deps, {
    name: "autolinks",
    description: "Autolink references of a repository: key prefix, URL template, alphanumeric or numeric.",
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({ autolinks: Schema.Array(Autolink) }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const items = yield* resolved.api.paginate<AutolinkData>(`/repos/${GitHubRepo.slug(resolved.repo)}/autolinks`)
        return {
          autolinks: items.map((item) => ({
            id: item.id,
            key_prefix: item.key_prefix,
            url_template: item.url_template,
            is_alphanumeric: item.is_alphanumeric,
          })),
        }
      }),
  })

  const autolinkUpdate = GitHubShared.define(deps, {
    name: "autolink_update",
    description: [
      "Create an autolink reference on a repository, or delete one by id.",
      'url_template must contain "<num>", which is replaced by the reference after key_prefix.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      key_prefix: Opt(Schema.String).annotate({ description: 'Prefix such as "TICKET-". Required to create.' }),
      url_template: Opt(Schema.String).annotate({
        description: 'Target URL containing "<num>". Required to create.',
      }),
      is_alphanumeric: Opt(Schema.Boolean).annotate({
        description: "Default true: match letters as well as digits after the prefix.",
      }),
      id: Opt(Schema.Int).annotate({ description: "Autolink to delete." }),
    }),
    output: Schema.Struct({
      action: Schema.Literals(["created", "deleted"]),
      id: Schema.Int,
      key_prefix: Opt(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const creating = input.key_prefix !== undefined || input.url_template !== undefined
        if (input.id !== undefined && creating)
          return yield* invalid("Pass id to delete, or key_prefix and url_template to create.")
        if (input.id === undefined && (input.key_prefix === undefined || input.url_template === undefined))
          return yield* invalid("Creating needs key_prefix and url_template.")
        if (input.url_template !== undefined && !input.url_template.includes("<num>"))
          return yield* invalid(
            'url_template must contain "<num>".',
            "Example: https://jira.example.com/browse/TICKET-<num>",
          )
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/autolinks`
        if (input.id !== undefined) {
          yield* GitHubShared.authorize(deps, context, "autolink_update", resolved.repo, {
            id: input.id,
            action: "delete",
          })
          yield* resolved.api.request("DELETE", `${base}/${input.id}`)
          return { action: "deleted" as const, id: input.id }
        }
        const alphanumeric = input.is_alphanumeric ?? true
        yield* GitHubShared.authorize(deps, context, "autolink_update", resolved.repo, {
          key_prefix: input.key_prefix,
          url_template: input.url_template,
          action: "create",
        })
        const created = yield* resolved.api.json<AutolinkData>("POST", base, {
          body: { key_prefix: input.key_prefix, url_template: input.url_template, is_alphanumeric: alphanumeric },
        })
        return { action: "created" as const, id: created.id, key_prefix: created.key_prefix }
      }),
  })

  return [
    collaborators,
    collaboratorUpdate,
    properties,
    propertySet,
    deployKeys,
    deployKeyUpdate,
    autolinks,
    autolinkUpdate,
  ]
}
