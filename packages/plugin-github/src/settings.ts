export * as GitHubSettings from "./settings.js"

import { readFile } from "node:fs/promises"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubExplore } from "./explore.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api
type Scope = "repo" | "environment" | "org"
type App = "actions" | "dependabot" | "codespaces"

const Opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const StringList = Schema.Array(Schema.String)
const Body = Schema.Record(Schema.String, Schema.Unknown)

const ScopeField = Schema.Literals(["repo", "environment", "org"])
const ListScopeField = Opt(Schema.Literals(["repo", "environment", "org", "all"])).annotate({
  description:
    'Where to look. "all" (default) covers the repository, every environment and organization entries shared with the repository.',
})
const WriteScopeField = Opt(ScopeField).annotate({ description: 'Where the entry lives. Default "repo".' })
const EnvironmentField = Opt(Schema.String).annotate({
  description: 'Environment name; required for scope "environment".',
})
const OrgField = Opt(Schema.String).annotate({
  description: 'Organization for scope "org". Defaults to the repository owner.',
})
const AppField = Opt(Schema.Literals(["actions", "dependabot", "codespaces"])).annotate({
  description: "Secret store. Default actions; environments only have actions secrets.",
})
const VisibilityField = Opt(Schema.Literals(["all", "private", "selected"])).annotate({
  description: 'Organization scope only: which repositories can use it. Default "private" when created.',
})
const RepositoriesField = Opt(StringList).annotate({
  description: 'Organization scope with visibility "selected": repository names in that organization.',
})

const Location = {
  scope: ScopeField,
  environment: Opt(Schema.String),
  org: Opt(Schema.String),
}

const defaultHost = () => process.env.GH_HOST || "github.com"
const enc = encodeURIComponent

const invalid = (message: string, hint?: string) =>
  new GitHubClient.Error({ kind: "validation", message, ...(hint ? { hint } : {}) })

const soft = (error: GitHubClient.Error) => error.kind === "forbidden" || error.kind === "not_found"
const reason = (error: GitHubClient.Error) =>
  error.kind === "forbidden" ? "requires admin access" : "not found or requires admin access"

interface Section<A> {
  readonly items: ReadonlyArray<A>
  readonly notes: ReadonlyArray<string>
}

// Settings endpoints answer 403 or 404 without admin access; those become notes instead of failing the whole call.
const section = <A>(label: string, effect: Effect.Effect<ReadonlyArray<A>, GitHubClient.Error>) =>
  effect.pipe(
    Effect.map((items): Section<A> => ({ items, notes: [] })),
    Effect.catchIf(soft, (error) => Effect.succeed<Section<A>>({ items: [], notes: [`${label}: ${reason(error)}`] })),
  )

const merge = <A>(sections: ReadonlyArray<Section<A>>) => ({
  items: sections.flatMap((item) => item.items),
  notes: sections.flatMap((item) => item.notes),
})

/** Resolves the repository; an explicit organization with no repository falls back to the default host when needed. */
const locate = Effect.fn("GitHubSettings.locate")(function* (
  deps: Deps,
  input: { readonly repo?: string; readonly scope?: string; readonly org?: string },
) {
  if (input.scope === "org" && input.org !== undefined && input.repo === undefined) {
    const local = Option.getOrUndefined(yield* GitHubShared.target(deps).pipe(Effect.option))
    return {
      api: local?.api ?? deps.client.forHost(defaultHost()),
      repo: local?.repo,
      org: input.org,
    }
  }
  const resolved = yield* GitHubShared.target(deps, input.repo)
  return { api: resolved.api, repo: resolved.repo as GitHubRepo.Ref | undefined, org: input.org ?? resolved.repo.owner }
})

interface Place {
  readonly api: Api
  readonly repo?: GitHubRepo.Ref
  /** The permission resource: the repository, or `owner/*` for organization entries. */
  readonly ref: GitHubRepo.Ref
  readonly base: string
  readonly location: { readonly scope: Scope; readonly environment?: string; readonly org?: string }
}

/** The collection endpoint for one variable or secret scope. */
const place = Effect.fn("GitHubSettings.place")(function* (
  deps: Deps,
  input: { readonly repo?: string; readonly scope?: Scope; readonly environment?: string; readonly org?: string },
  kind: "variables" | "secrets",
  app: App,
) {
  const scope = input.scope ?? "repo"
  const found = yield* locate(deps, { ...input, scope })
  if (scope === "org")
    return {
      api: found.api,
      ref: { host: found.api.host, owner: found.org, name: "*" },
      base: `/orgs/${enc(found.org)}/${app}/${kind}`,
      location: { scope, org: found.org },
    } satisfies Place as Place
  const repo = found.repo
  if (!repo) return yield* invalid("No repository to act on.", "Pass `repo` as owner/name.")
  const slug = GitHubRepo.slug(repo)
  if (scope === "repo")
    return {
      api: found.api,
      repo,
      ref: repo,
      base: `/repos/${slug}/${app}/${kind}`,
      location: { scope },
    } satisfies Place as Place
  if (input.environment === undefined) return yield* invalid('scope "environment" needs `environment`.')
  if (app !== "actions") return yield* invalid(`Environments only have actions secrets, not ${app}.`)
  return {
    api: found.api,
    repo,
    ref: repo,
    base: `/repos/${slug}/environments/${enc(input.environment)}/${kind}`,
    location: { scope, environment: input.environment },
  } satisfies Place as Place
})

/** Resolves organization repository names to ids for `selected` visibility. */
const repositoryIds = (api: Api, org: string, names: ReadonlyArray<string>) =>
  Effect.forEach(
    names,
    (name) => api.json<{ id: number }>("GET", `/repos/${enc(org)}/${enc(name)}`).pipe(Effect.map((repo) => repo.id)),
    { concurrency: 4 },
  )

const checkVisibility = (
  location: Place["location"],
  visibility: string | undefined,
  repositories: ReadonlyArray<string> | undefined,
) => {
  if (location.scope !== "org" && (visibility !== undefined || repositories !== undefined))
    return Effect.fail(invalid("visibility and repositories only apply to organization scope."))
  if (repositories !== undefined && visibility !== "selected")
    return Effect.fail(invalid('repositories needs visibility "selected".'))
  if (visibility === "selected" && !repositories?.length)
    return Effect.fail(invalid('visibility "selected" needs repositories.'))
  return Effect.void
}

interface EnvironmentData {
  readonly name: string
  readonly html_url?: string
  readonly can_admins_bypass?: boolean
  readonly protection_rules?: ReadonlyArray<{
    readonly type: string
    readonly wait_timer?: number
    readonly prevent_self_review?: boolean
    readonly reviewers?: ReadonlyArray<{
      readonly type: string
      readonly reviewer?: { readonly login?: string; readonly slug?: string; readonly name?: string } | null
    }>
  }>
  readonly deployment_branch_policy?: {
    readonly protected_branches: boolean
    readonly custom_branch_policies: boolean
  } | null
}

interface BranchPolicyData {
  readonly id: number
  readonly name: string
  readonly type?: string
}

const environmentNames = (api: Api, slug: string) =>
  api
    .paginate<{ name: string }>(`/repos/${slug}/environments`, { key: "environments" })
    .pipe(Effect.map((items) => items.map((item) => item.name)))

const policyLabel = (policy: BranchPolicyData) => (policy.type === "tag" ? `tag:${policy.name}` : policy.name)

const countOf = (api: Api, path: string) =>
  api.json<{ total_count: number }>("GET", path, { query: { per_page: 1 } }).pipe(
    Effect.map((data) => data.total_count as number | undefined),
    Effect.catchIf(soft, () => Effect.succeed(undefined)),
  )

interface RulesetData {
  readonly id: number
  readonly name: string
  readonly target?: string
  readonly enforcement: string
  readonly source?: string
  readonly source_type?: string
  readonly conditions?: Record<string, unknown> | null
  readonly rules?: ReadonlyArray<{ readonly type: string; readonly parameters?: unknown }>
  readonly bypass_actors?: ReadonlyArray<{
    readonly actor_type: string
    readonly actor_id?: number | null
    readonly bypass_mode: string
  }>
  readonly _links?: { readonly html?: { readonly href?: string } }
}

const rulesetView = (data: RulesetData) => ({
  id: data.id,
  name: data.name,
  ...(data.target ? { target: data.target } : {}),
  enforcement: data.enforcement,
  ...(data.source ? { source: data.source } : {}),
  ...(data.source_type ? { source_type: data.source_type } : {}),
  ...(data.conditions ? { conditions: data.conditions } : {}),
  ...(data.rules
    ? {
        rules: data.rules.map((rule) => ({
          type: rule.type,
          ...(rule.parameters === undefined ? {} : { parameters: rule.parameters }),
        })),
      }
    : {}),
  ...(data.bypass_actors
    ? {
        bypass_actors: data.bypass_actors.map((actor) => ({
          actor_type: actor.actor_type,
          ...(actor.actor_id === undefined || actor.actor_id === null ? {} : { actor_id: actor.actor_id }),
          bypass_mode: actor.bypass_mode,
        })),
      }
    : {}),
  ...(data._links?.html?.href ? { url: data._links.html.href } : {}),
})

interface Actors {
  readonly users?: ReadonlyArray<{ readonly login: string }>
  readonly teams?: ReadonlyArray<{ readonly slug: string }>
  readonly apps?: ReadonlyArray<{ readonly slug: string }>
}

const actors = (data: Actors | undefined) => ({
  users: (data?.users ?? []).map((item) => item.login),
  teams: (data?.teams ?? []).map((item) => item.slug),
  apps: (data?.apps ?? []).map((item) => item.slug),
})

interface ProtectionData {
  readonly required_status_checks?: {
    readonly strict?: boolean
    readonly contexts?: ReadonlyArray<string>
    readonly checks?: ReadonlyArray<{ readonly context: string; readonly app_id?: number | null }>
  } | null
  readonly required_pull_request_reviews?: {
    readonly required_approving_review_count?: number
    readonly dismiss_stale_reviews?: boolean
    readonly require_code_owner_reviews?: boolean
    readonly require_last_push_approval?: boolean
    readonly dismissal_restrictions?: Actors
    readonly bypass_pull_request_allowances?: Actors
  } | null
  readonly enforce_admins?: { readonly enabled: boolean }
  readonly restrictions?: Actors | null
  readonly required_linear_history?: { readonly enabled: boolean }
  readonly allow_force_pushes?: { readonly enabled: boolean }
  readonly allow_deletions?: { readonly enabled: boolean }
  readonly required_conversation_resolution?: { readonly enabled: boolean }
  readonly lock_branch?: { readonly enabled: boolean }
  readonly allow_fork_syncing?: { readonly enabled: boolean }
  readonly required_signatures?: { readonly enabled: boolean }
}

const flag = (key: string, value: { readonly enabled: boolean } | undefined) =>
  value === undefined ? {} : { [key]: value.enabled }

const Actor = Schema.Struct({ users: StringList, teams: StringList, apps: StringList })

const REPO_FIELDS = [
  "description",
  "homepage",
  "visibility",
  "default_branch",
  "has_issues",
  "has_wiki",
  "has_projects",
  "has_discussions",
  "allow_merge_commit",
  "allow_squash_merge",
  "allow_rebase_merge",
  "allow_auto_merge",
  "allow_update_branch",
  "delete_branch_on_merge",
  "squash_merge_commit_title",
  "squash_merge_commit_message",
  "merge_commit_title",
  "merge_commit_message",
  "web_commit_signoff_required",
  "allow_forking",
  "is_template",
  "use_squash_pr_title_as_default",
  "has_pull_requests",
  "pull_request_creation_policy",
  "archived",
] as const

export function tools(deps: Deps): Tool.Info[] {
  const variables = GitHubShared.define(deps, {
    name: "variables",
    description: [
      "List GitHub Actions variables with values across repository, environment and organization scopes.",
      'Default scope "all": repository variables, every environment\'s variables and organization variables shared with the repository. Sections the account cannot read become notes.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      scope: ListScopeField,
      environment: Opt(Schema.String).annotate({ description: "Only this environment's variables." }),
      org: OrgField,
    }),
    output: Schema.Struct({
      variables: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          value: Schema.String,
          ...Location,
          visibility: Opt(Schema.String),
          updated_at: Opt(Schema.String),
        }),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const scope = input.scope ?? "all"
        const found = yield* locate(deps, { ...input, scope })
        const api = found.api
        interface VariableData {
          readonly name: string
          readonly value: string
          readonly visibility?: string
          readonly updated_at?: string
        }
        const view = (location: Place["location"]) => (item: VariableData) => ({
          name: item.name,
          value: item.value,
          ...location,
          ...(item.visibility ? { visibility: item.visibility } : {}),
          ...(item.updated_at ? { updated_at: item.updated_at } : {}),
        })
        const list = (path: string) => api.paginate<VariableData>(path, { key: "variables" })
        if (scope === "org") {
          const result = yield* section(
            `organization ${found.org}`,
            list(`/orgs/${enc(found.org)}/actions/variables`).pipe(
              Effect.map((items) => items.map(view({ scope: "org", org: found.org }))),
            ),
          )
          return { variables: result.items, notes: result.notes }
        }
        const repo = found.repo
        if (!repo) return yield* invalid("No repository to read.", "Pass `repo` as owner/name.")
        const slug = GitHubRepo.slug(repo)
        const environment = (name: string) =>
          section(
            `environment ${name}`,
            list(`/repos/${slug}/environments/${enc(name)}/variables`).pipe(
              Effect.map((items) => items.map(view({ scope: "environment", environment: name }))),
            ),
          )
        const environments = () =>
          input.environment !== undefined
            ? environment(input.environment)
            : section("environments", environmentNames(api, slug)).pipe(
                Effect.flatMap((names) =>
                  Effect.forEach(names.items, environment, { concurrency: 4 }).pipe(
                    Effect.map((sections) => merge([{ items: [], notes: names.notes }, ...sections])),
                  ),
                ),
              )
        const repository = () =>
          section(
            "repository",
            list(`/repos/${slug}/actions/variables`).pipe(Effect.map((items) => items.map(view({ scope: "repo" })))),
          )
        const shared = () =>
          section(
            "organization",
            list(`/repos/${slug}/actions/organization-variables`).pipe(
              Effect.map((items) => items.map(view({ scope: "org", org: repo.owner }))),
            ),
          )
        const sections =
          scope === "repo"
            ? [yield* repository()]
            : scope === "environment"
              ? [yield* environments()]
              : yield* Effect.all([repository(), environments(), shared()], { concurrency: 3 })
        const result = merge(sections)
        return { variables: result.items, notes: result.notes }
      }),
  })

  const variableSet = GitHubShared.define(deps, {
    name: "variable_set",
    description: [
      "Create, update or delete one GitHub Actions variable in a repository, environment or organization.",
      'Organization variables take visibility; "selected" needs repositories (names in that organization).',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      name: Schema.String,
      value: Opt(Schema.String).annotate({ description: "Required unless delete." }),
      delete: Opt(Schema.Boolean),
      scope: WriteScopeField,
      environment: EnvironmentField,
      org: OrgField,
      visibility: VisibilityField,
      repositories: RepositoriesField,
    }),
    output: Schema.Struct({
      name: Schema.String,
      ...Location,
      action: Schema.Literals(["created", "updated", "deleted"]),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const target = yield* place(deps, input, "variables", "actions")
        yield* checkVisibility(target.location, input.visibility, input.repositories)
        if (!input.delete && input.value === undefined) return yield* invalid("value is required unless delete.")
        const action = input.delete ? "delete" : "set"
        yield* GitHubShared.authorize(deps, context, "variable_set", target.ref, {
          name: input.name,
          ...target.location,
          action,
        })
        const path = `${target.base}/${enc(input.name)}`
        if (input.delete) {
          yield* target.api.request("DELETE", path)
          return { name: input.name, ...target.location, action: "deleted" as const }
        }
        const ids =
          input.repositories && target.location.org
            ? yield* repositoryIds(target.api, target.location.org, input.repositories)
            : undefined
        const body = {
          name: input.name,
          value: input.value,
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(ids ? { selected_repository_ids: ids } : {}),
        }
        const updated = yield* target.api.request("PATCH", path, { body, allow: [404] })
        if (updated.status !== 404) return { name: input.name, ...target.location, action: "updated" as const }
        yield* target.api.request("POST", target.base, {
          body: {
            ...body,
            ...(target.location.scope === "org" ? { visibility: input.visibility ?? "private" } : {}),
          },
        })
        return { name: input.name, ...target.location, action: "created" as const }
      }),
  })

  const secrets = GitHubShared.define(deps, {
    name: "secrets",
    description: [
      "List GitHub secret names (never values) for Actions, Dependabot or Codespaces across scopes.",
      'Default scope "all": repository secrets, plus for actions every environment\'s secrets and organization secrets shared with the repository. Sections the account cannot read become notes.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      scope: ListScopeField,
      environment: Opt(Schema.String).annotate({ description: "Only this environment's secrets." }),
      org: OrgField,
      app: AppField,
    }),
    output: Schema.Struct({
      secrets: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          ...Location,
          app: Schema.String,
          visibility: Opt(Schema.String),
          created_at: Opt(Schema.String),
          updated_at: Opt(Schema.String),
        }),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const scope = input.scope ?? "all"
        const app = input.app ?? "actions"
        if (scope === "environment" && app !== "actions")
          return yield* invalid(`Environments only have actions secrets, not ${app}.`)
        const found = yield* locate(deps, { ...input, scope })
        const api = found.api
        interface SecretData {
          readonly name: string
          readonly visibility?: string
          readonly created_at?: string
          readonly updated_at?: string
        }
        const view = (location: Place["location"]) => (item: SecretData) => ({
          name: item.name,
          ...location,
          app,
          ...(item.visibility ? { visibility: item.visibility } : {}),
          ...(item.created_at ? { created_at: item.created_at } : {}),
          ...(item.updated_at ? { updated_at: item.updated_at } : {}),
        })
        const list = (path: string) => api.paginate<SecretData>(path, { key: "secrets" })
        if (scope === "org") {
          const result = yield* section(
            `organization ${found.org}`,
            list(`/orgs/${enc(found.org)}/${app}/secrets`).pipe(
              Effect.map((items) => items.map(view({ scope: "org", org: found.org }))),
            ),
          )
          return { secrets: result.items, notes: result.notes }
        }
        const repo = found.repo
        if (!repo) return yield* invalid("No repository to read.", "Pass `repo` as owner/name.")
        const slug = GitHubRepo.slug(repo)
        const environment = (name: string) =>
          section(
            `environment ${name}`,
            list(`/repos/${slug}/environments/${enc(name)}/secrets`).pipe(
              Effect.map((items) => items.map(view({ scope: "environment", environment: name }))),
            ),
          )
        const environments = () =>
          input.environment !== undefined
            ? environment(input.environment)
            : section("environments", environmentNames(api, slug)).pipe(
                Effect.flatMap((names) =>
                  Effect.forEach(names.items, environment, { concurrency: 4 }).pipe(
                    Effect.map((sections) => merge([{ items: [], notes: names.notes }, ...sections])),
                  ),
                ),
              )
        const repository = () =>
          section(
            "repository",
            list(`/repos/${slug}/${app}/secrets`).pipe(Effect.map((items) => items.map(view({ scope: "repo" })))),
          )
        const shared = () =>
          section(
            "organization",
            list(`/repos/${slug}/actions/organization-secrets`).pipe(
              Effect.map((items) => items.map(view({ scope: "org", org: repo.owner }))),
            ),
          )
        const sections =
          scope === "repo" || (scope === "all" && app !== "actions")
            ? [yield* repository()]
            : scope === "environment"
              ? [yield* environments()]
              : yield* Effect.all([repository(), environments(), shared()], { concurrency: 3 })
        const result = merge(sections)
        return { secrets: result.items, notes: result.notes }
      }),
  })

  const secretSet = GitHubShared.define(deps, {
    name: "secret_set",
    description: [
      "Set or delete one GitHub secret (Actions, Dependabot, Codespaces) in a repository, environment or organization.",
      "Prefer from_file or from_env over value so the secret never enters the conversation; the value is never echoed.",
      "Setting encrypts through the gh CLI, which must be installed. File contents are used as-is.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      name: Schema.String,
      value: Opt(Schema.String).annotate({ description: "Secret value. Prefer from_file or from_env." }),
      from_file: Opt(Schema.String).annotate({ description: "Local file whose contents become the secret." }),
      from_env: Opt(Schema.String).annotate({
        description: "Name of an environment variable of the OpenCode process holding the secret.",
      }),
      delete: Opt(Schema.Boolean),
      scope: WriteScopeField,
      environment: EnvironmentField,
      org: OrgField,
      app: AppField,
      visibility: VisibilityField,
      repositories: RepositoriesField,
    }),
    output: Schema.Struct({
      name: Schema.String,
      ...Location,
      app: Schema.String,
      action: Schema.Literals(["set", "deleted"]),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const app = input.app ?? "actions"
        const target = yield* place(deps, input, "secrets", app)
        yield* checkVisibility(target.location, input.visibility, input.repositories)
        const sources = [input.value, input.from_file, input.from_env].filter((item) => item !== undefined).length
        if (!input.delete && sources !== 1)
          return yield* invalid("Pass exactly one of value, from_file or from_env (or delete: true).")
        const authorize = GitHubShared.authorize(deps, context, "secret_set", target.ref, {
          name: input.name,
          ...target.location,
          app,
          action: input.delete ? "delete" : "set",
        })
        if (input.delete) {
          yield* authorize
          yield* target.api.request("DELETE", `${target.base}/${enc(input.name)}`)
          return { name: input.name, ...target.location, app, action: "deleted" as const }
        }
        const value =
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
            : input.from_env !== undefined
              ? process.env[input.from_env]
              : input.value
        if (value === undefined) return yield* invalid(`Environment variable ${input.from_env} is not set.`)
        if (value === "") return yield* invalid("Refusing to set an empty secret.")
        yield* authorize
        const location = target.location
        const repo = target.repo
        const scopeArgs =
          location.scope === "org"
            ? [
                "--org",
                location.org ?? "",
                "--visibility",
                input.visibility ?? "private",
                ...(input.repositories?.length ? ["--repos", input.repositories.join(",")] : []),
              ]
            : [
                "--repo",
                repo ? `${repo.host}/${GitHubRepo.slug(repo)}` : "",
                ...(location.environment !== undefined ? ["--env", location.environment] : []),
              ]
        // The value goes on stdin: arguments are visible to other processes.
        const result = yield* deps.run("gh", ["secret", "set", input.name, "--app", app, ...scopeArgs], {
          input: value,
          timeout: 60_000,
          // --org takes no host, so gh needs GH_HOST to reach an Enterprise organization.
          env: { GH_HOST: target.api.host },
        })
        if (result.exitCode !== 0) {
          const stderr = result.stderr.split(value).join("[redacted]").trim()
          const missing = result.exitCode === 127 || /ENOENT|command not found|executable file not found/i.test(stderr)
          return yield* new GitHubClient.Error({
            kind: missing ? "unsupported" : "validation",
            message: `gh secret set failed (exit ${result.exitCode})${stderr ? `: ${stderr}` : ""}`,
            ...(missing
              ? { hint: "Setting secrets needs the gh CLI for encryption. Install it from https://cli.github.com." }
              : {}),
          })
        }
        return { name: input.name, ...location, app, action: "set" as const }
      }),
  })

  const Reviewer = Schema.Struct({ type: Schema.Literals(["User", "Team"]), login: Schema.String })

  const environments = GitHubShared.define(deps, {
    name: "environments",
    description: [
      "Deployment environments in detail: reviewers, wait timer, deployment branch policy, variable and secret counts.",
      'Branch patterns read "name" for branches and "tag:name" for tags.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      name: Opt(Schema.String).annotate({ description: "One environment. Omit for all." }),
    }),
    output: Schema.Struct({
      environments: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          url: Opt(Schema.String),
          wait_timer: Opt(Schema.Number),
          prevent_self_review: Opt(Schema.Boolean),
          reviewers: Schema.Array(Reviewer),
          can_admins_bypass: Opt(Schema.Boolean),
          deployment_branch_policy: Schema.Struct({
            protected_branches: Schema.Boolean,
            custom_branch_policies: Schema.Boolean,
            branches: Opt(StringList),
          }),
          counts: Schema.Struct({ variables: Opt(Schema.Number), secrets: Opt(Schema.Number) }),
        }),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const listed = yield* section(
          input.name === undefined ? "environments" : `environment ${input.name}`,
          input.name === undefined
            ? api.paginate<EnvironmentData>(`/repos/${slug}/environments`, { key: "environments" })
            : api
                .json<EnvironmentData>("GET", `/repos/${slug}/environments/${enc(input.name)}`)
                .pipe(Effect.map((item) => [item])),
        )
        const details = yield* Effect.forEach(
          listed.items,
          (environment) =>
            Effect.gen(function* () {
              const base = `/repos/${slug}/environments/${enc(environment.name)}`
              const policy = environment.deployment_branch_policy
              const branches = policy?.custom_branch_policies
                ? yield* section(
                    `environment ${environment.name} branch policies`,
                    api.paginate<BranchPolicyData>(`${base}/deployment-branch-policies`, { key: "branch_policies" }),
                  )
                : undefined
              const [variableCount, secretCount] = yield* Effect.all(
                [countOf(api, `${base}/variables`), countOf(api, `${base}/secrets`)],
                { concurrency: 2 },
              )
              const rules = environment.protection_rules ?? []
              const wait = rules.find((rule) => rule.type === "wait_timer")?.wait_timer
              const review = rules.find((rule) => rule.type === "required_reviewers")
              return {
                notes: branches?.notes ?? [],
                item: {
                  name: environment.name,
                  ...(environment.html_url ? { url: environment.html_url } : {}),
                  ...(wait === undefined ? {} : { wait_timer: wait }),
                  ...(review?.prevent_self_review === undefined
                    ? {}
                    : { prevent_self_review: review.prevent_self_review }),
                  reviewers: (review?.reviewers ?? []).map((item) => ({
                    type: item.type === "Team" ? ("Team" as const) : ("User" as const),
                    login: item.reviewer?.login ?? item.reviewer?.slug ?? item.reviewer?.name ?? "",
                  })),
                  ...(environment.can_admins_bypass === undefined
                    ? {}
                    : { can_admins_bypass: environment.can_admins_bypass }),
                  deployment_branch_policy: {
                    protected_branches: policy?.protected_branches ?? false,
                    custom_branch_policies: policy?.custom_branch_policies ?? false,
                    ...(branches && branches.notes.length === 0 ? { branches: branches.items.map(policyLabel) } : {}),
                  },
                  counts: {
                    ...(variableCount === undefined ? {} : { variables: variableCount }),
                    ...(secretCount === undefined ? {} : { secrets: secretCount }),
                  },
                },
              }
            }),
          { concurrency: 4 },
        )
        return {
          environments: details.map((detail) => detail.item),
          notes: [...listed.notes, ...details.flatMap((detail) => detail.notes)],
        }
      }),
  })

  const environmentUpdate = GitHubShared.define(deps, {
    name: "environment_update",
    description: [
      "Create or update a deployment environment (reviewers, wait timer, deployment branches), or delete it.",
      'branches: "all", "protected", or name patterns ("release/*", "tag:v*"); patterns replace the existing list.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      name: Schema.String,
      delete: Opt(Schema.Boolean),
      wait_timer: Opt(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 43200 }))).annotate({
        description: "Minutes to wait before deploying.",
      }),
      prevent_self_review: Opt(Schema.Boolean),
      reviewers: Opt(Schema.Array(Reviewer)).annotate({
        description: "Required reviewers: users by login, teams by slug in the repository owner's organization.",
      }),
      can_admins_bypass: Opt(Schema.Boolean),
      branches: Opt(Schema.Union([Schema.Literals(["all", "protected"]), StringList])),
    }),
    output: Schema.Struct({
      name: Schema.String,
      action: Schema.Literals(["updated", "deleted"]),
      changed: StringList,
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/environments/${enc(input.name)}`
        yield* GitHubShared.authorize(deps, context, "environment_update", resolved.repo, {
          name: input.name,
          action: input.delete ? "delete" : "update",
        })
        if (input.delete) {
          yield* api.request("DELETE", base)
          return { name: input.name, action: "deleted" as const, changed: [] }
        }
        const reviewers = input.reviewers
          ? yield* Effect.forEach(
              input.reviewers,
              (reviewer) =>
                api
                  .json<{
                    id: number
                  }>(
                    "GET",
                    reviewer.type === "User"
                      ? `/users/${enc(reviewer.login)}`
                      : `/orgs/${enc(resolved.repo.owner)}/teams/${enc(reviewer.login)}`,
                  )
                  .pipe(Effect.map((found) => ({ type: reviewer.type, id: found.id }))),
              { concurrency: 4 },
            )
          : undefined
        const branches = input.branches
        const policy =
          branches === undefined
            ? undefined
            : branches === "all"
              ? null
              : branches === "protected"
                ? { protected_branches: true, custom_branch_policies: false }
                : { protected_branches: false, custom_branch_policies: true }
        const body = {
          ...(input.wait_timer === undefined ? {} : { wait_timer: input.wait_timer }),
          ...(input.prevent_self_review === undefined ? {} : { prevent_self_review: input.prevent_self_review }),
          ...(reviewers ? { reviewers } : {}),
          ...(input.can_admins_bypass === undefined ? {} : { can_admins_bypass: input.can_admins_bypass }),
          ...(policy === undefined ? {} : { deployment_branch_policy: policy }),
        }
        yield* api.request("PUT", base, { body })
        const changed = [
          ...Object.keys(body).filter((key) => key !== "deployment_branch_policy"),
          ...(branches === undefined ? [] : ["branches"]),
        ]
        if (!Array.isArray(branches)) return { name: input.name, action: "updated" as const, changed }
        const wanted = branches.map((pattern) =>
          pattern.startsWith("tag:") ? { name: pattern.slice(4), type: "tag" } : { name: pattern, type: "branch" },
        )
        const existing = yield* api.paginate<BranchPolicyData>(`${base}/deployment-branch-policies`, {
          key: "branch_policies",
        })
        const same = (left: { name: string; type?: string }, right: { name: string; type?: string }) =>
          left.name === right.name && (left.type ?? "branch") === (right.type ?? "branch")
        const added = wanted.filter((item) => !existing.some((current) => same(current, item)))
        const removed = existing.filter((current) => !wanted.some((item) => same(current, item)))
        yield* Effect.forEach(
          added,
          (item) => api.request("POST", `${base}/deployment-branch-policies`, { body: item }),
          {
            concurrency: 4,
            discard: true,
          },
        )
        yield* Effect.forEach(
          removed,
          (item) => api.request("DELETE", `${base}/deployment-branch-policies/${item.id}`),
          { concurrency: 4, discard: true },
        )
        return {
          name: input.name,
          action: "updated" as const,
          changed: [
            ...changed,
            ...added.map((item) => `added ${policyLabel({ id: 0, ...item })}`),
            ...removed.map((item) => `removed ${policyLabel(item)}`),
          ],
        }
      }),
  })

  const RulesetView = Schema.Struct({
    id: Schema.Int,
    name: Schema.String,
    target: Opt(Schema.String),
    enforcement: Schema.String,
    source: Opt(Schema.String),
    source_type: Opt(Schema.String),
    conditions: Opt(Body),
    rules: Opt(Schema.Array(Schema.Struct({ type: Schema.String, parameters: Opt(Schema.Unknown) }))),
    bypass_actors: Opt(
      Schema.Array(Schema.Struct({ actor_type: Schema.String, actor_id: Opt(Schema.Int), bypass_mode: Schema.String })),
    ),
    url: Opt(Schema.String),
  })

  const rulesets = GitHubShared.define(deps, {
    name: "rulesets",
    description: [
      "Repository or organization rulesets in detail (conditions, rules, bypass actors), or the rules that apply to a branch.",
      "Default lists the repository's rulesets including inherited organization ones. Sections the account cannot read become notes.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      id: Opt(Schema.Int).annotate({ description: "One ruleset." }),
      branch: Opt(Schema.String).annotate({
        description: "Show the rules in effect for this branch instead; needs only read access.",
      }),
      org: Opt(Schema.String).annotate({ description: "List organization rulesets instead." }),
    }),
    output: Schema.Struct({
      rulesets: Opt(Schema.Array(RulesetView)),
      branch: Opt(Schema.String),
      rules: Opt(
        Schema.Array(
          Schema.Struct({ type: Schema.String, ruleset_id: Opt(Schema.Int), parameters: Opt(Schema.Unknown) }),
        ),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const found = yield* locate(deps, { repo: input.repo, scope: input.org ? "org" : "repo", org: input.org })
        const api = found.api
        if (input.branch !== undefined) {
          if (!found.repo) return yield* invalid("branch needs a repository.", "Pass `repo` as owner/name.")
          const branch = input.branch
          const listed = yield* section(
            `branch ${branch}`,
            api.paginate<{ type: string; ruleset_id?: number; parameters?: unknown }>(
              `/repos/${GitHubRepo.slug(found.repo)}/rules/branches/${GitHubShared.refPath(branch)}`,
            ),
          )
          return {
            branch,
            rules: listed.items.map((rule) => ({
              type: rule.type,
              ...(rule.ruleset_id === undefined ? {} : { ruleset_id: rule.ruleset_id }),
              ...(rule.parameters === undefined ? {} : { parameters: rule.parameters }),
            })),
            notes: listed.notes,
          }
        }
        const repo = found.repo
        const base = input.org
          ? `/orgs/${enc(input.org)}/rulesets`
          : repo
            ? `/repos/${GitHubRepo.slug(repo)}/rulesets`
            : undefined
        if (!base) return yield* invalid("No repository to read.", "Pass `repo` as owner/name.")
        const query = input.org ? undefined : { includes_parents: true }
        if (input.id !== undefined)
          return {
            rulesets: [rulesetView(yield* api.json<RulesetData>("GET", `${base}/${input.id}`, { query }))],
            notes: [],
          }
        const listed = yield* section(
          input.org ? `organization ${input.org}` : "rulesets",
          api.paginate<RulesetData>(base, { query }),
        )
        const details = yield* Effect.forEach(
          listed.items,
          (summary) =>
            api.json<RulesetData>("GET", `${base}/${summary.id}`, { query }).pipe(
              Effect.map((data) => ({ item: rulesetView(data), note: undefined })),
              Effect.catchIf(soft, (error) =>
                Effect.succeed({ item: rulesetView(summary), note: `ruleset ${summary.id}: ${reason(error)}` }),
              ),
            ),
          { concurrency: 4 },
        )
        return {
          rulesets: details.map((detail) => detail.item),
          notes: [...listed.notes, ...details.flatMap((detail) => (detail.note === undefined ? [] : [detail.note]))],
        }
      }),
  })

  const rulesetUpdate = GitHubShared.define(deps, {
    name: "ruleset_update",
    description: [
      "Create, update or delete a repository or organization ruleset.",
      "ruleset is the JSON body of GitHub's rulesets API: name, target, enforcement, conditions, rules, bypass_actors.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      org: Opt(Schema.String).annotate({ description: "Act on an organization ruleset instead." }),
      id: Opt(Schema.Int).annotate({ description: "Ruleset to update or delete. Omit to create." }),
      delete: Opt(Schema.Boolean),
      ruleset: Opt(Body),
    }),
    output: Schema.Struct({
      id: Opt(Schema.Int),
      name: Opt(Schema.String),
      action: Schema.Literals(["created", "updated", "deleted"]),
      enforcement: Opt(Schema.String),
      url: Opt(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.delete && input.id === undefined) return yield* invalid("delete needs id.")
        if (!input.delete && input.ruleset === undefined) return yield* invalid("ruleset is required unless delete.")
        const found = yield* locate(deps, { repo: input.repo, scope: input.org ? "org" : "repo", org: input.org })
        const repo = found.repo
        const target = input.org
          ? { ref: { host: found.api.host, owner: input.org, name: "*" }, base: `/orgs/${enc(input.org)}/rulesets` }
          : repo
            ? { ref: repo, base: `/repos/${GitHubRepo.slug(repo)}/rulesets` }
            : undefined
        if (!target) return yield* invalid("No repository to act on.", "Pass `repo` as owner/name.")
        const action = input.delete
          ? ("deleted" as const)
          : input.id === undefined
            ? ("created" as const)
            : ("updated" as const)
        yield* GitHubShared.authorize(deps, context, "ruleset_update", target.ref, {
          ...(input.id === undefined ? {} : { id: input.id }),
          action,
        })
        if (input.delete) {
          yield* found.api.request("DELETE", `${target.base}/${input.id}`)
          return { ...(input.id === undefined ? {} : { id: input.id }), action: "deleted" as const }
        }
        const data = yield* found.api
          .json<RulesetData>(
            input.id === undefined ? "POST" : "PUT",
            input.id === undefined ? target.base : `${target.base}/${input.id}`,
            {
              body: input.ruleset,
            },
          )
          .pipe(
            Effect.catchIf(
              (error) => error.status === 422,
              (error) =>
                Effect.fail(
                  new GitHubClient.Error({
                    kind: "validation",
                    status: 422,
                    message: error.message,
                    hint: "GitHub rejected the ruleset body; check it against the rulesets API (rules, conditions, bypass_actors).",
                  }),
                ),
            ),
          )
        return {
          id: data.id,
          name: data.name,
          action,
          enforcement: data.enforcement,
          ...(data._links?.html?.href ? { url: data._links.html.href } : {}),
        }
      }),
  })

  const branchProtection = GitHubShared.define(deps, {
    name: "branch_protection",
    description: [
      "Classic branch protection for one branch in full (default: the default branch): checks, reviews, restrictions, flags.",
      "Rulesets apply separately; see rulesets with branch.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      branch: Opt(Schema.String).annotate({ description: "Branch name. Defaults to the default branch." }),
    }),
    output: Schema.Struct({
      branch: Schema.String,
      protected: Opt(Schema.Boolean),
      available: Opt(Schema.Boolean),
      reason: Opt(Schema.String),
      fallback: Opt(Schema.String),
      note: Opt(Schema.String),
      required_status_checks: Opt(
        Schema.Struct({
          strict: Schema.Boolean,
          contexts: StringList,
          checks: Schema.Array(Schema.Struct({ context: Schema.String, app_id: Opt(Schema.Int) })),
        }),
      ),
      required_pull_request_reviews: Opt(
        Schema.Struct({
          required_approving_review_count: Schema.Int,
          dismiss_stale_reviews: Schema.Boolean,
          require_code_owner_reviews: Schema.Boolean,
          require_last_push_approval: Schema.Boolean,
          dismissal: Actor,
          bypass: Actor,
        }),
      ),
      restrictions: Opt(Actor),
      enforce_admins: Opt(Schema.Boolean),
      required_linear_history: Opt(Schema.Boolean),
      allow_force_pushes: Opt(Schema.Boolean),
      allow_deletions: Opt(Schema.Boolean),
      required_signatures: Opt(Schema.Boolean),
      required_conversation_resolution: Opt(Schema.Boolean),
      lock_branch: Opt(Schema.Boolean),
      allow_fork_syncing: Opt(Schema.Boolean),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const branch =
          input.branch ?? (yield* api.json<{ default_branch: string }>("GET", `/repos/${slug}`)).default_branch
        const path = `/repos/${slug}/branches/${GitHubShared.refPath(branch)}/protection`
        const response = yield* api.request<ProtectionData>("GET", path, { allow: [403, 404] })
        if (response.status === 404)
          return {
            branch,
            protected: false,
            note: "not protected (rulesets may still apply; see rulesets with branch)",
          }
        if (response.status === 403)
          return {
            branch,
            available: false,
            reason: "requires admin access",
            fallback: "rulesets({ branch }) shows the rules that apply",
          }
        const data = response.data
        const signatures = yield* api
          .request<{ enabled: boolean }>("GET", `${path}/required_signatures`, {
            accept: "application/vnd.github+json",
            allow: [403, 404],
          })
          .pipe(Effect.map((result) => (result.status < 400 ? result.data : data.required_signatures)))
        const checks = data.required_status_checks
        const reviews = data.required_pull_request_reviews
        return {
          branch,
          protected: true,
          ...(checks
            ? {
                required_status_checks: {
                  strict: checks.strict ?? false,
                  contexts: [...(checks.contexts ?? [])],
                  checks: (checks.checks ?? []).map((check) => ({
                    context: check.context,
                    ...(check.app_id === undefined || check.app_id === null ? {} : { app_id: check.app_id }),
                  })),
                },
              }
            : {}),
          ...(reviews
            ? {
                required_pull_request_reviews: {
                  required_approving_review_count: reviews.required_approving_review_count ?? 0,
                  dismiss_stale_reviews: reviews.dismiss_stale_reviews ?? false,
                  require_code_owner_reviews: reviews.require_code_owner_reviews ?? false,
                  require_last_push_approval: reviews.require_last_push_approval ?? false,
                  dismissal: actors(reviews.dismissal_restrictions),
                  bypass: actors(reviews.bypass_pull_request_allowances),
                },
              }
            : {}),
          ...(data.restrictions ? { restrictions: actors(data.restrictions) } : {}),
          ...flag("enforce_admins", data.enforce_admins),
          ...flag("required_linear_history", data.required_linear_history),
          ...flag("allow_force_pushes", data.allow_force_pushes),
          ...flag("allow_deletions", data.allow_deletions),
          ...flag("required_signatures", signatures),
          ...flag("required_conversation_resolution", data.required_conversation_resolution),
          ...flag("lock_branch", data.lock_branch),
          ...flag("allow_fork_syncing", data.allow_fork_syncing),
        }
      }),
  })

  const branchProtectionUpdate = GitHubShared.define(deps, {
    name: "branch_protection_update",
    description: [
      "Replace or delete classic branch protection on one branch.",
      "protection is GitHub's full PUT body: required_status_checks, enforce_admins, required_pull_request_reviews, restrictions, and optional flags.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      branch: Schema.String,
      protection: Opt(Body),
      delete: Opt(Schema.Boolean),
    }),
    output: Schema.Struct({ branch: Schema.String, action: Schema.Literals(["updated", "deleted"]) }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (!input.delete && input.protection === undefined)
          return yield* invalid("protection is required unless delete.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        yield* GitHubShared.authorize(deps, context, "branch_protection_update", resolved.repo, {
          branch: input.branch,
          action: input.delete ? "delete" : "update",
        })
        const path = `/repos/${GitHubRepo.slug(resolved.repo)}/branches/${GitHubShared.refPath(input.branch)}/protection`
        if (input.delete) {
          yield* resolved.api.request("DELETE", path)
          return { branch: input.branch, action: "deleted" as const }
        }
        yield* resolved.api.request("PUT", path, { body: input.protection })
        return { branch: input.branch, action: "updated" as const }
      }),
  })

  const repoUpdate = GitHubShared.define(deps, {
    name: "repo_update",
    description:
      "Change repository settings: description, visibility, default branch, features, merge options, archiving, topics.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      description: Opt(Schema.String),
      homepage: Opt(Schema.String),
      visibility: Opt(Schema.Literals(["public", "private", "internal"])),
      default_branch: Opt(Schema.String),
      has_issues: Opt(Schema.Boolean),
      has_wiki: Opt(Schema.Boolean),
      has_projects: Opt(Schema.Boolean),
      has_discussions: Opt(Schema.Boolean),
      allow_merge_commit: Opt(Schema.Boolean),
      allow_squash_merge: Opt(Schema.Boolean),
      allow_rebase_merge: Opt(Schema.Boolean),
      allow_auto_merge: Opt(Schema.Boolean),
      allow_update_branch: Opt(Schema.Boolean),
      delete_branch_on_merge: Opt(Schema.Boolean),
      squash_merge_commit_title: Opt(Schema.Literals(["PR_TITLE", "COMMIT_OR_PR_TITLE"])),
      squash_merge_commit_message: Opt(Schema.Literals(["PR_BODY", "COMMIT_MESSAGES", "BLANK"])),
      merge_commit_title: Opt(Schema.Literals(["PR_TITLE", "MERGE_MESSAGE"])),
      merge_commit_message: Opt(Schema.Literals(["PR_BODY", "PR_TITLE", "BLANK"])),
      web_commit_signoff_required: Opt(Schema.Boolean),
      allow_forking: Opt(Schema.Boolean),
      is_template: Opt(Schema.Boolean),
      use_squash_pr_title_as_default: Opt(Schema.Boolean),
      has_pull_requests: Opt(Schema.Boolean),
      pull_request_creation_policy: Opt(Schema.String).annotate({
        description: "Who may open pull requests, such as all.",
      }),
      merge_commit_default: Opt(
        Schema.Literals(["Default message", "Pull request title", "Pull request title and description"]),
      ).annotate({
        description: "The merge commit message by the settings page's name; sets merge_commit_title and _message.",
      }),
      squash_commit_default: Opt(
        Schema.Literals([
          "Default message",
          "Pull request title",
          "Pull request title and commit details",
          "Pull request title and description",
        ]),
      ).annotate({
        description:
          "The squash commit message by the settings page's name; sets squash_merge_commit_title and _message.",
      }),
      release_immutability: Opt(Schema.Boolean).annotate({
        description: "Lock assets and tags of published releases.",
      }),
      archived: Opt(Schema.Boolean),
      topics: Opt(StringList).annotate({ description: "Replaces all topics." }),
    }),
    output: Schema.Struct({
      repo: Schema.String,
      changed: StringList,
      not_applied: Opt(StringList).annotate({
        description:
          "Settings GitHub accepted without changing, usually because a plan, policy or organization rule decides them.",
      }),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const merge = input.merge_commit_default ? GitHubExplore.MERGE_DEFAULTS[input.merge_commit_default] : undefined
        const squash = input.squash_commit_default
          ? GitHubExplore.SQUASH_DEFAULTS[input.squash_commit_default]
          : undefined
        const body: Record<string, unknown> = Object.fromEntries([
          ...REPO_FIELDS.flatMap((key) => (input[key] === undefined ? [] : [[key, input[key]]])),
          ...(merge ? [["merge_commit_title", merge[0]] as const, ["merge_commit_message", merge[1]] as const] : []),
          ...(squash
            ? [["squash_merge_commit_title", squash[0]] as const, ["squash_merge_commit_message", squash[1]] as const]
            : []),
        ])
        const changed = [
          ...Object.keys(body),
          ...(input.topics === undefined ? [] : ["topics"]),
          ...(input.release_immutability === undefined ? [] : ["release_immutability"]),
        ]
        if (changed.length === 0) return yield* invalid("Nothing to change; pass at least one setting.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        yield* GitHubShared.authorize(deps, context, "repo_update", resolved.repo, { changed })
        // GitHub answers 200 and keeps the old value for settings a plan or policy decides, so compare the answer.
        const patch =
          Object.keys(body).length > 0
            ? resolved.api.json<Record<string, unknown>>("PATCH", `/repos/${slug}`, { body }).pipe(
                Effect.map((after) =>
                  Object.entries(body)
                    .filter(([key, value]) => key in after && after[key] !== value)
                    .map(([key]) => key),
                ),
              )
            : Effect.succeed([] as string[])
        const topics =
          input.topics === undefined
            ? Effect.void
            : resolved.api.request("PUT", `/repos/${slug}/topics`, { body: { names: input.topics } })
        const immutability =
          input.release_immutability === undefined
            ? Effect.void
            : resolved.api.request(input.release_immutability ? "PUT" : "DELETE", `/repos/${slug}/immutable-releases`)
        // An archived repository is read-only, so everything else goes first when archiving and after unarchiving.
        const others = Effect.andThen(topics, immutability)
        const ignored =
          input.archived === true ? yield* Effect.andThen(others, patch) : yield* Effect.tap(patch, () => others)
        return {
          repo: slug,
          changed: changed.filter((key) => !ignored.includes(key)),
          ...(ignored.length ? { not_applied: ignored } : {}),
        }
      }),
  })

  return [
    variables,
    variableSet,
    secrets,
    secretSet,
    environments,
    environmentUpdate,
    rulesets,
    rulesetUpdate,
    branchProtection,
    branchProtectionUpdate,
    repoUpdate,
  ]
}
