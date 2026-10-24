export * as GitHubAutomation from "./automation.js"

import { readFile } from "node:fs/promises"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api

const Opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const StringList = Schema.Array(Schema.String)
const enc = encodeURIComponent
const defaultHost = () => process.env.GH_HOST || "github.com"

const invalid = (message: string, hint?: string) =>
  new GitHubClient.Error({ kind: "validation", message, ...(hint ? { hint } : {}) })

// Settings endpoints answer 403/404 without admin access, 409 when a mode does not apply and 422 for the wrong
// repository visibility; each of those describes one part of the answer rather than failing the whole call.
const SOFT_STATUSES = [403, 404, 409, 422]
const soft = (error: GitHubClient.Error) =>
  error.kind === "forbidden" || error.kind === "not_found" || SOFT_STATUSES.includes(error.status ?? 0)

/** GitHub's own message without the method and path prefix the client adds. */
const message = (error: GitHubClient.Error) => {
  const match = /^[A-Z]+ \S+ failed \((\d+)\)(?::\s*(.*))?$/s.exec(error.message)
  if (!match) return error.message
  return match[2] ? `${match[2]} (${match[1]})` : `HTTP ${match[1]}`
}

/** Reads one optional part: a soft failure becomes a note and the part is left out. */
const part = <A>(label: string, effect: Effect.Effect<A, GitHubClient.Error>) =>
  effect.pipe(
    Effect.map((value) => ({ value: value as A | undefined, notes: [] as string[] })),
    Effect.catchIf(soft, (error) =>
      Effect.succeed({ value: undefined as A | undefined, notes: [`${label}: ${message(error)}`] }),
    ),
  )

/** The API and organization for organization-level tools; an explicit org without a repository needs no checkout. */
const organization = Effect.fn("GitHubAutomation.organization")(function* (
  deps: Deps,
  input: { readonly repo?: string; readonly org?: string },
) {
  if (input.org !== undefined && input.repo === undefined) {
    const local = Option.getOrUndefined(yield* GitHubShared.target(deps).pipe(Effect.option))
    return { api: local?.api ?? deps.client.forHost(defaultHost()), repo: local?.repo, org: input.org }
  }
  const resolved = yield* GitHubShared.target(deps, input.repo)
  return {
    api: resolved.api,
    repo: resolved.repo as GitHubRepo.Ref | undefined,
    org: input.org ?? resolved.repo.owner,
  }
})

const orgRef = (api: Api, org: string): GitHubRepo.Ref => ({ host: api.host, owner: org, name: "*" })

const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as Partial<T>

/** Reads a secret from exactly one of value, file or environment variable, approving the file read first. */
const secretValue = Effect.fn("GitHubAutomation.secretValue")(function* (
  deps: Deps,
  context: Tool.Context,
  input: { readonly secret?: string; readonly secret_from_file?: string; readonly secret_from_env?: string },
) {
  const sources = [input.secret, input.secret_from_file, input.secret_from_env].filter((item) => item !== undefined)
  if (sources.length > 1) return yield* invalid("Pass at most one of secret, secret_from_file or secret_from_env.")
  if (input.secret_from_file !== undefined) {
    const file = yield* GitHubShared.readable(deps, context, input.secret_from_file)
    return yield* Effect.tryPromise({
      try: () => readFile(file, "utf8"),
      catch: (cause) =>
        invalid(
          `Unable to read ${input.secret_from_file}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
        ),
    })
  }
  if (input.secret_from_env !== undefined) {
    const value = process.env[input.secret_from_env]
    if (value === undefined) return yield* invalid(`Environment variable ${input.secret_from_env} is not set.`)
    return value
  }
  return input.secret
})

const redact = (secret: string | undefined) => (error: GitHubClient.Error) => {
  if (!secret) return error
  const scrub = (text: string) => text.split(secret).join("[redacted]")
  return new GitHubClient.Error({
    kind: error.kind,
    message: scrub(error.message),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.hint === undefined ? {} : { hint: scrub(error.hint) }),
  })
}

interface PermissionsData {
  readonly enabled: boolean
  readonly allowed_actions?: string
}

interface HookData {
  readonly id: number
  readonly name: string
  readonly active: boolean
  readonly events: ReadonlyArray<string>
  readonly config: {
    readonly url?: string
    readonly content_type?: string
    readonly insecure_ssl?: string | number
    readonly secret?: string
  }
  readonly last_response?: {
    readonly code: number | null
    readonly status: string | null
    readonly message: string | null
  } | null
}

const hookView = (hook: HookData) => ({
  id: hook.id,
  name: hook.name,
  active: hook.active,
  events: [...hook.events],
  ...(hook.config.url ? { url: hook.config.url } : {}),
  ...(hook.config.content_type ? { content_type: hook.config.content_type } : {}),
  insecure_ssl: String(hook.config.insecure_ssl ?? "0") === "1",
  // GitHub masks the secret, but only its presence is ever useful, so nothing else of it leaves this function.
  has_secret: hook.config.secret !== undefined && hook.config.secret !== "",
  ...(hook.last_response
    ? {
        last_response: defined({
          code: hook.last_response.code ?? undefined,
          status: hook.last_response.status ?? undefined,
          message: hook.last_response.message ?? undefined,
        }),
      }
    : {}),
})

const HookView = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  active: Schema.Boolean,
  events: StringList,
  url: Opt(Schema.String),
  content_type: Opt(Schema.String),
  insecure_ssl: Schema.Boolean,
  has_secret: Schema.Boolean,
  last_response: Opt(
    Schema.Struct({ code: Opt(Schema.Number), status: Opt(Schema.String), message: Opt(Schema.String) }),
  ),
})

interface CloudAgentData {
  readonly mcp_configuration?: unknown
  readonly enabled_tools?: Record<string, boolean> | null
  readonly require_actions_workflow_approval?: boolean
  readonly is_firewall_enabled?: boolean
  readonly is_firewall_recommended_allowlist_enabled?: boolean
  readonly custom_allowlist?: unknown
  readonly is_automations_enabled?: boolean
  readonly require_write_access_for_automation_triggers?: boolean
}

const Section = { available: Schema.Boolean, reason: Opt(Schema.String) }

const SHA = /^[0-9a-f]{40}$/i

export function tools(deps: Deps): Tool.Info[] {
  const actionsSettings = GitHubShared.define(deps, {
    name: "actions_settings",
    description: [
      "Repository GitHub Actions settings: allowed actions, workflow token permissions, retention, OIDC, runners.",
      "Also fork pull request approval policy and access from other repositories. Parts the account cannot read, or that do not apply to this repository, become notes.",
    ].join("\n"),
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({
      enabled: Opt(Schema.Boolean),
      allowed_actions: Opt(Schema.String),
      selected_actions: Opt(
        Schema.Struct({
          github_owned_allowed: Opt(Schema.Boolean),
          verified_allowed: Opt(Schema.Boolean),
          patterns_allowed: StringList,
        }),
      ),
      workflow_permissions: Opt(
        Schema.Struct({
          default_workflow_permissions: Schema.String,
          can_approve_pull_request_reviews: Schema.Boolean,
        }),
      ),
      retention: Opt(Schema.Struct({ days: Schema.Number, maximum_allowed_days: Opt(Schema.Number) })),
      fork_pr_approval: Opt(Schema.String),
      access_level: Opt(Schema.String),
      oidc_subject: Opt(Schema.Struct({ use_default: Schema.Boolean, include_claim_keys: Opt(StringList) })),
      runners: Opt(
        Schema.Array(
          Schema.Struct({
            id: Schema.Int,
            name: Schema.String,
            os: Schema.String,
            status: Schema.String,
            busy: Schema.Boolean,
            labels: StringList,
          }),
        ),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/actions`
        const get = <A>(path: string) => api.json<A>("GET", `${base}${path}`)
        const [permissions, workflow, retention, fork, access, oidc, runners] = yield* Effect.all(
          [
            part("permissions", get<PermissionsData>("/permissions")),
            part(
              "workflow permissions",
              get<{ default_workflow_permissions: string; can_approve_pull_request_reviews: boolean }>(
                "/permissions/workflow",
              ),
            ),
            part(
              "retention",
              get<{ days: number; maximum_allowed_days?: number }>("/permissions/artifact-and-log-retention"),
            ),
            part(
              "fork pull request approval",
              get<{ approval_policy: string }>("/permissions/fork-pr-contributor-approval"),
            ),
            part("access", get<{ access_level: string }>("/permissions/access")),
            part(
              "oidc subject",
              get<{ use_default: boolean; include_claim_keys?: ReadonlyArray<string> }>("/oidc/customization/sub"),
            ),
            part(
              "runners",
              api.paginate<{
                id: number
                name: string
                os: string
                status: string
                busy: boolean
                labels?: ReadonlyArray<{ name: string }>
              }>(`${base}/runners`, { key: "runners" }),
            ),
          ],
          { concurrency: 7 },
        )
        const selected =
          permissions.value?.allowed_actions === "selected"
            ? yield* part(
                "selected actions",
                get<{
                  github_owned_allowed?: boolean
                  verified_allowed?: boolean
                  patterns_allowed?: ReadonlyArray<string>
                }>("/permissions/selected-actions"),
              )
            : undefined
        return {
          ...(permissions.value
            ? {
                enabled: permissions.value.enabled,
                ...(permissions.value.allowed_actions ? { allowed_actions: permissions.value.allowed_actions } : {}),
              }
            : {}),
          ...(selected?.value
            ? {
                selected_actions: {
                  ...defined({
                    github_owned_allowed: selected.value.github_owned_allowed,
                    verified_allowed: selected.value.verified_allowed,
                  }),
                  patterns_allowed: [...(selected.value.patterns_allowed ?? [])],
                },
              }
            : {}),
          ...(workflow.value
            ? {
                workflow_permissions: {
                  default_workflow_permissions: workflow.value.default_workflow_permissions,
                  can_approve_pull_request_reviews: workflow.value.can_approve_pull_request_reviews,
                },
              }
            : {}),
          ...(retention.value
            ? {
                retention: defined({
                  days: retention.value.days,
                  maximum_allowed_days: retention.value.maximum_allowed_days,
                }) as { days: number; maximum_allowed_days?: number },
              }
            : {}),
          ...(fork.value ? { fork_pr_approval: fork.value.approval_policy } : {}),
          ...(access.value ? { access_level: access.value.access_level } : {}),
          ...(oidc.value
            ? {
                oidc_subject: {
                  use_default: oidc.value.use_default,
                  ...(oidc.value.include_claim_keys ? { include_claim_keys: [...oidc.value.include_claim_keys] } : {}),
                },
              }
            : {}),
          ...(runners.value
            ? {
                runners: runners.value.map((runner) => ({
                  id: runner.id,
                  name: runner.name,
                  os: runner.os,
                  status: runner.status,
                  busy: runner.busy,
                  labels: (runner.labels ?? []).map((label) => label.name),
                })),
              }
            : {}),
          notes: [permissions, selected, workflow, retention, fork, access, oidc, runners].flatMap(
            (item) => item?.notes ?? [],
          ),
        }
      }),
  })

  const actionsSettingsUpdate = GitHubShared.define(deps, {
    name: "actions_settings_update",
    description: [
      "Change repository GitHub Actions settings: allowed actions, workflow token permissions, retention, OIDC subject.",
      'Also fork pull request approval and access from other repositories. selected_actions needs allowed_actions "selected".',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      enabled: Opt(Schema.Boolean).annotate({ description: "Whether Actions runs at all in this repository." }),
      allowed_actions: Opt(Schema.Literals(["all", "local_only", "selected"])),
      selected_actions: Opt(
        Schema.Struct({
          github_owned_allowed: Opt(Schema.Boolean),
          verified_allowed: Opt(Schema.Boolean),
          patterns_allowed: Opt(StringList).annotate({ description: 'Patterns such as "octo-org/*@v2".' }),
        }),
      ),
      default_workflow_permissions: Opt(Schema.Literals(["read", "write"])).annotate({
        description: "Default GITHUB_TOKEN permissions.",
      }),
      can_approve_pull_request_reviews: Opt(Schema.Boolean).annotate({
        description: "Whether GITHUB_TOKEN may approve pull requests.",
      }),
      retention_days: Opt(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 }))).annotate({
        description: "Artifact and log retention in days.",
      }),
      fork_pr_approval: Opt(
        Schema.Literals([
          "first_time_contributors_new_to_github",
          "first_time_contributors",
          "all_external_contributors",
        ]),
      ).annotate({ description: "Which fork pull request authors need approval before workflows run." }),
      access_level: Opt(Schema.Literals(["none", "user", "organization", "enterprise"])).annotate({
        description: "Private and internal repositories only: who outside the repository may use its workflows.",
      }),
      oidc_subject: Opt(Schema.Struct({ use_default: Schema.Boolean, include_claim_keys: Opt(StringList) })).annotate({
        description: "OIDC token subject claim template.",
      }),
    }),
    output: Schema.Struct({ changed: StringList }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const changed = (
          [
            "enabled",
            "allowed_actions",
            "selected_actions",
            "default_workflow_permissions",
            "can_approve_pull_request_reviews",
            "retention_days",
            "fork_pr_approval",
            "access_level",
            "oidc_subject",
          ] as const
        ).filter((key) => input[key] !== undefined)
        if (changed.length === 0) return yield* invalid("Nothing to change; pass at least one setting.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/actions`
        yield* GitHubShared.authorize(deps, context, "actions_settings_update", resolved.repo, { changed })
        const put = (path: string, body: unknown) => api.request("PUT", `${base}${path}`, { body })
        if (input.enabled !== undefined || input.allowed_actions !== undefined) {
          // The endpoint takes both together, so the one not given keeps its current value.
          const current =
            input.enabled !== undefined && input.allowed_actions !== undefined
              ? undefined
              : yield* api.json<PermissionsData>("GET", `${base}/permissions`)
          const allowed = input.allowed_actions ?? current?.allowed_actions
          yield* put("/permissions", {
            enabled: input.enabled ?? current?.enabled ?? true,
            ...(allowed ? { allowed_actions: allowed } : {}),
          })
        }
        if (input.selected_actions !== undefined)
          yield* put("/permissions/selected-actions", defined({ ...input.selected_actions }))
        if (input.default_workflow_permissions !== undefined || input.can_approve_pull_request_reviews !== undefined)
          yield* put(
            "/permissions/workflow",
            defined({
              default_workflow_permissions: input.default_workflow_permissions,
              can_approve_pull_request_reviews: input.can_approve_pull_request_reviews,
            }),
          )
        if (input.retention_days !== undefined)
          yield* put("/permissions/artifact-and-log-retention", { days: input.retention_days })
        if (input.fork_pr_approval !== undefined)
          yield* put("/permissions/fork-pr-contributor-approval", { approval_policy: input.fork_pr_approval })
        if (input.access_level !== undefined) yield* put("/permissions/access", { access_level: input.access_level })
        if (input.oidc_subject !== undefined) yield* put("/oidc/customization/sub", defined({ ...input.oidc_subject }))
        return { changed: [...changed] }
      }),
  })

  const webhooks = GitHubShared.define(deps, {
    name: "webhooks",
    description: [
      "Repository webhooks: URL, events, content type, whether a secret is set (never its value), last response.",
      "Pass id for one webhook with its recent deliveries.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      id: Opt(Schema.Int).annotate({ description: "One webhook, with its recent deliveries." }),
      deliveries: GitHubShared.limit(100, 10),
    }),
    output: Schema.Struct({
      hooks: Schema.Array(HookView),
      deliveries: Opt(
        Schema.Array(
          Schema.Struct({
            id: Schema.Number,
            event: Schema.String,
            action: Opt(Schema.String),
            status: Schema.String,
            status_code: Schema.Number,
            delivered_at: Schema.String,
            duration: Schema.Number,
            redelivery: Schema.Boolean,
          }),
        ),
      ),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/hooks`
        if (input.id === undefined) {
          const hooks = yield* api.paginate<HookData>(base)
          return { hooks: hooks.map(hookView) }
        }
        const hook = yield* api.json<HookData>("GET", `${base}/${input.id}`)
        const deliveries = yield* api.json<
          ReadonlyArray<{
            id: number
            event: string
            action: string | null
            status: string
            status_code: number
            delivered_at: string
            duration: number
            redelivery: boolean
          }>
        >("GET", `${base}/${input.id}/deliveries`, { query: { per_page: input.deliveries ?? 10 } })
        return {
          hooks: [hookView(hook)],
          deliveries: deliveries.map((item) => ({
            id: item.id,
            event: item.event,
            ...(item.action ? { action: item.action } : {}),
            status: item.status,
            status_code: item.status_code,
            delivered_at: item.delivered_at,
            duration: item.duration,
            redelivery: item.redelivery,
          })),
        }
      }),
  })

  const webhookUpdate = GitHubShared.define(deps, {
    name: "webhook_update",
    description: [
      "Create, update, delete, ping, test or redeliver a repository webhook.",
      "Prefer secret_from_file or secret_from_env over secret so it never enters the conversation; it is never echoed. File contents are used as-is.",
      "Updating config fields keeps the existing secret unless a new one is given. test sends the latest push to push webhooks.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      action: Schema.Literals(["create", "update", "delete", "ping", "test", "redeliver"]),
      id: Opt(Schema.Int).annotate({ description: "Webhook id; required except for create." }),
      url: Opt(Schema.String).annotate({ description: "Payload URL; required for create." }),
      events: Opt(StringList).annotate({
        description: 'Events to deliver; replaces the list. Default ["push"] on create.',
      }),
      content_type: Opt(Schema.Literals(["json", "form"])).annotate({ description: 'Default "json" on create.' }),
      active: Opt(Schema.Boolean).annotate({ description: "Default true on create." }),
      insecure_ssl: Opt(Schema.Boolean).annotate({ description: "Skip TLS verification. Default false on create." }),
      secret: Opt(Schema.String).annotate({
        description: "Signing secret. Prefer secret_from_file or secret_from_env.",
      }),
      secret_from_file: Opt(Schema.String).annotate({ description: "Local file whose contents become the secret." }),
      secret_from_env: Opt(Schema.String).annotate({
        description: "Name of an environment variable of the OpenCode process holding the secret.",
      }),
      delivery_id: Opt(Schema.Number).annotate({ description: "Delivery to send again; required for redeliver." }),
    }),
    output: Schema.Struct({
      id: Opt(Schema.Int),
      action: Schema.Literals(["created", "updated", "deleted", "pinged", "tested", "redelivered"]),
      url: Opt(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.action === "create" && input.url === undefined) return yield* invalid("create needs url.")
        if (input.action !== "create" && input.id === undefined) return yield* invalid(`${input.action} needs id.`)
        if (input.action === "redeliver" && input.delivery_id === undefined)
          return yield* invalid("redeliver needs delivery_id.")
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/hooks`
        const secret =
          input.action === "create" || input.action === "update" ? yield* secretValue(deps, context, input) : undefined
        if (secret === "") return yield* invalid("Refusing to set an empty secret.")
        yield* GitHubShared.authorize(deps, context, "webhook_update", resolved.repo, {
          action: input.action,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.events === undefined ? {} : { events: input.events }),
          ...(secret === undefined ? {} : { secret: "set" }),
        })
        const scrub = redact(secret)
        const id = input.id ?? 0
        const config = defined({
          url: input.url,
          content_type: input.content_type,
          insecure_ssl: input.insecure_ssl === undefined ? undefined : input.insecure_ssl ? "1" : "0",
          secret,
        })
        if (input.action === "create") {
          const created = yield* api
            .json<HookData>("POST", base, {
              body: {
                name: "web",
                active: input.active ?? true,
                events: input.events ?? ["push"],
                config: { content_type: "json", insecure_ssl: "0", ...config },
              },
            })
            .pipe(Effect.mapError(scrub))
          return {
            id: created.id,
            action: "created" as const,
            ...(created.config.url ? { url: created.config.url } : {}),
          }
        }
        if (input.action === "update") {
          const hook = defined({ events: input.events, active: input.active })
          if (Object.keys(hook).length === 0 && Object.keys(config).length === 0)
            return yield* invalid(
              "Nothing to change; pass url, events, content_type, active, insecure_ssl or a secret.",
            )
          // PATCH on the hook drops the secret unless it is sent again, so config changes go to the config endpoint.
          if (Object.keys(config).length > 0)
            yield* api.request("PATCH", `${base}/${id}/config`, { body: config }).pipe(Effect.mapError(scrub))
          if (Object.keys(hook).length > 0) yield* api.request("PATCH", `${base}/${id}`, { body: hook })
          return { id, action: "updated" as const, ...(input.url === undefined ? {} : { url: input.url }) }
        }
        if (input.action === "delete") {
          yield* api.request("DELETE", `${base}/${id}`)
          return { id, action: "deleted" as const }
        }
        if (input.action === "ping") {
          yield* api.request("POST", `${base}/${id}/pings`)
          return { id, action: "pinged" as const }
        }
        if (input.action === "test") {
          yield* api.request("POST", `${base}/${id}/tests`)
          return { id, action: "tested" as const }
        }
        yield* api.request("POST", `${base}/${id}/deliveries/${input.delivery_id}/attempts`)
        return { id, action: "redelivered" as const }
      }),
  })

  const Source = Schema.Struct({ branch: Schema.String, path: Schema.String })

  const pages = GitHubShared.define(deps, {
    name: "pages",
    description: [
      "GitHub Pages site for a repository: status, URL, build type, source branch and path, custom domain, HTTPS.",
      "Includes the latest build for branch (legacy) builds. Returns enabled: false when Pages is off.",
    ].join("\n"),
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({
      enabled: Schema.Boolean,
      status: Opt(Schema.String),
      html_url: Opt(Schema.String),
      build_type: Opt(Schema.String),
      source: Opt(Source),
      cname: Opt(Schema.String),
      https_enforced: Opt(Schema.Boolean),
      public: Opt(Schema.Boolean),
      latest_build: Opt(
        Schema.Struct({ status: Schema.String, error: Opt(Schema.String), created_at: Opt(Schema.String) }),
      ),
      notes: StringList,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/pages`
        const response = yield* api.request<{
          status?: string | null
          html_url?: string
          build_type?: string | null
          source?: { branch: string; path: string } | null
          cname?: string | null
          https_enforced?: boolean
          public?: boolean
        }>("GET", base, { allow: [404] })
        if (response.status === 404) return { enabled: false, notes: [] }
        const data = response.data
        const build =
          data.build_type === "workflow"
            ? undefined
            : yield* part(
                "latest build",
                api.json<{ status: string; error?: { message?: string | null } | null; created_at?: string }>(
                  "GET",
                  `${base}/builds/latest`,
                ),
              )
        return {
          enabled: true,
          ...defined({
            status: data.status ?? undefined,
            html_url: data.html_url,
            build_type: data.build_type ?? undefined,
            cname: data.cname ?? undefined,
            https_enforced: data.https_enforced,
            public: data.public,
          }),
          ...(data.source ? { source: { branch: data.source.branch, path: data.source.path } } : {}),
          ...(build?.value
            ? {
                latest_build: {
                  status: build.value.status,
                  ...defined({ error: build.value.error?.message ?? undefined, created_at: build.value.created_at }),
                },
              }
            : {}),
          notes: build?.notes ?? [],
        }
      }),
  })

  const pagesUpdate = GitHubShared.define(deps, {
    name: "pages_update",
    description: [
      "Enable, update or disable GitHub Pages for a repository, or request a build of a branch-built site.",
      'build_type "workflow" publishes from a GitHub Actions workflow; "legacy" builds from branch and path.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      action: Schema.Literals(["enable", "update", "disable", "build"]),
      build_type: Opt(Schema.Literals(["legacy", "workflow"])),
      branch: Opt(Schema.String).annotate({ description: "Source branch for legacy builds." }),
      path: Opt(Schema.Literals(["/", "/docs"])).annotate({ description: 'Source folder. Default "/".' }),
      cname: Opt(Schema.String).annotate({ description: 'Custom domain; "" removes it. update only.' }),
      https_enforced: Opt(Schema.Boolean).annotate({ description: "update only." }),
    }),
    output: Schema.Struct({
      action: Schema.Literals(["enabled", "updated", "disabled", "build_requested"]),
      changed: Opt(StringList),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.path !== undefined && input.branch === undefined) return yield* invalid("path needs branch.")
        if (input.action === "enable" && input.build_type !== "workflow" && input.branch === undefined)
          return yield* invalid('enable needs branch, or build_type "workflow".')
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const base = `/repos/${GitHubRepo.slug(resolved.repo)}/pages`
        const source = input.branch === undefined ? undefined : { branch: input.branch, path: input.path ?? "/" }
        const body = defined({
          build_type: input.build_type,
          source,
          ...(input.action === "update"
            ? { cname: input.cname === "" ? null : input.cname, https_enforced: input.https_enforced }
            : {}),
        })
        if (input.action === "update" && Object.keys(body).length === 0)
          return yield* invalid("Nothing to change; pass cname, https_enforced, build_type or branch.")
        yield* GitHubShared.authorize(deps, context, "pages_update", resolved.repo, {
          action: input.action,
          ...(input.action === "update" || input.action === "enable" ? { changed: Object.keys(body) } : {}),
        })
        if (input.action === "disable") {
          yield* api.request("DELETE", base)
          return { action: "disabled" as const }
        }
        if (input.action === "build") {
          yield* api.request("POST", `${base}/builds`)
          return { action: "build_requested" as const }
        }
        if (input.action === "enable") {
          yield* api.request("POST", base, { body })
          return { action: "enabled" as const, changed: Object.keys(body) }
        }
        yield* api.request("PUT", base, { body })
        return { action: "updated" as const, changed: Object.keys(body) }
      }),
  })

  const tags = GitHubShared.define(deps, {
    name: "tags",
    description: [
      "List a repository's git tags with the commit each points at, in GitHub's order.",
      "Tag protection now lives in rulesets: see rulesets (target tag).",
    ].join("\n"),
    input: Schema.Struct({ repo: GitHubShared.RepoField, limit: GitHubShared.limit(500, 50) }),
    output: Schema.Struct({
      tags: Schema.Array(Schema.Struct({ name: Schema.String, sha: Schema.String, url: Opt(Schema.String) })),
      note: Schema.String,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        const listed = yield* resolved.api.paginate<{ name: string; commit: { sha: string } }>(`/repos/${slug}/tags`, {
          limit: input.limit ?? 50,
        })
        return {
          tags: listed.map((tag) => ({
            name: tag.name,
            sha: tag.commit.sha,
            url: `${resolved.api.web}/${slug}/tree/${GitHubShared.refPath(tag.name)}`,
          })),
          note: 'Tag protection is configured through rulesets with target "tag"; see the rulesets tool.',
        }
      }),
  })

  const tagUpdate = GitHubShared.define(deps, {
    name: "tag_update",
    description: [
      "Create a lightweight or annotated git tag on a commit, branch or ref, or delete a tag.",
      "Passing message makes an annotated tag. ref defaults to the default branch.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      tag: Schema.String.annotate({ description: 'Tag name without "refs/tags/".' }),
      ref: Opt(Schema.String).annotate({
        description: "Commit SHA, branch or ref to tag. Default: the default branch.",
      }),
      message: Opt(Schema.String).annotate({ description: "Annotation message; makes an annotated tag." }),
      delete: Opt(Schema.Boolean),
    }),
    output: Schema.Struct({
      tag: Schema.String,
      action: Schema.Literals(["created", "deleted"]),
      sha: Opt(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const tag = input.tag.replace(/^refs\/tags\//, "")
        if (input.delete) {
          yield* GitHubShared.authorize(deps, context, "tag_update", resolved.repo, { tag, action: "delete" })
          yield* api.request("DELETE", `/repos/${slug}/git/refs/tags/${GitHubShared.refPath(tag)}`)
          return { tag, action: "deleted" as const }
        }
        const ref = input.ref ?? (yield* api.json<{ default_branch: string }>("GET", `/repos/${slug}`)).default_branch
        const sha = SHA.test(ref)
          ? ref
          : (yield* api.json<{ sha: string }>("GET", `/repos/${slug}/commits/${GitHubShared.refPath(ref)}`)).sha
        yield* GitHubShared.authorize(deps, context, "tag_update", resolved.repo, {
          tag,
          sha,
          action: input.message === undefined ? "create" : "create annotated",
        })
        const object =
          input.message === undefined
            ? sha
            : (yield* api.json<{ sha: string }>("POST", `/repos/${slug}/git/tags`, {
                body: { tag, message: input.message, object: sha, type: "commit" },
              })).sha
        yield* api.request("POST", `/repos/${slug}/git/refs`, { body: { ref: `refs/tags/${tag}`, sha: object } })
        return { tag, action: "created" as const, sha }
      }),
  })

  const copilotSettings = GitHubShared.define(deps, {
    name: "copilot_settings",
    description: [
      "Copilot settings around a repository: cloud agent configuration, organization agent policy, seats, content exclusion.",
      "Each section reports available: false with a reason when the account cannot read it. Code review on push is set in rulesets.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      org: Opt(Schema.String).annotate({ description: "Organization. Defaults to the repository owner." }),
    }),
    output: Schema.Struct({
      cloud_agent: Schema.Struct({
        ...Section,
        mcp_configuration: Opt(Schema.Unknown),
        enabled_tools: Opt(Schema.Record(Schema.String, Schema.Boolean)),
        require_actions_workflow_approval: Opt(Schema.Boolean),
        is_firewall_enabled: Opt(Schema.Boolean),
        is_firewall_recommended_allowlist_enabled: Opt(Schema.Boolean),
        custom_allowlist: Opt(Schema.Unknown),
        is_automations_enabled: Opt(Schema.Boolean),
        require_write_access_for_automation_triggers: Opt(Schema.Boolean),
      }),
      organization: Schema.Struct({
        ...Section,
        org: Schema.String,
        enabled_repositories: Opt(Schema.String),
        repository_enabled: Opt(Schema.Boolean),
        plan_type: Opt(Schema.String),
        seat_breakdown: Opt(Schema.Record(Schema.String, Schema.Number)),
        notes: StringList,
      }),
      content_exclusion: Schema.Struct({ ...Section, rules: Opt(Schema.Record(Schema.String, StringList)) }),
      note: Schema.String,
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const found = yield* organization(deps, input)
        const api = found.api
        const org = enc(found.org)
        const repo = found.repo
        const unavailable = (error: GitHubClient.Error) => ({ available: false, reason: message(error) })
        const cloudAgent = repo
          ? yield* api
              .json<CloudAgentData>("GET", `/repos/${GitHubRepo.slug(repo)}/copilot/cloud-agent/configuration`)
              .pipe(
                Effect.map((data) => ({
                  available: true,
                  ...defined({
                    mcp_configuration: data.mcp_configuration ?? undefined,
                    enabled_tools: data.enabled_tools ?? undefined,
                    require_actions_workflow_approval: data.require_actions_workflow_approval,
                    is_firewall_enabled: data.is_firewall_enabled,
                    is_firewall_recommended_allowlist_enabled: data.is_firewall_recommended_allowlist_enabled,
                    custom_allowlist: data.custom_allowlist ?? undefined,
                    is_automations_enabled: data.is_automations_enabled,
                    require_write_access_for_automation_triggers: data.require_write_access_for_automation_triggers,
                  }),
                })),
                Effect.catchIf(soft, (error) => Effect.succeed(unavailable(error))),
              )
          : { available: false, reason: "no repository; pass repo" }
        const policy = yield* part(
          "cloud agent policy",
          api.json<{ enabled_repositories: string }>("GET", `/orgs/${org}/copilot/coding-agent/permissions`),
        )
        const listed =
          policy.value?.enabled_repositories === "selected" && repo
            ? yield* part(
                "cloud agent repositories",
                api.paginate<{ name: string; full_name?: string }>(
                  `/orgs/${org}/copilot/coding-agent/permissions/repositories`,
                  { key: "repositories" },
                ),
              )
            : undefined
        const billing = yield* part(
          "billing",
          api.json<{ plan_type?: string; seat_breakdown?: Record<string, number> }>(
            "GET",
            `/orgs/${org}/copilot/billing`,
          ),
        )
        const repositoryEnabled =
          policy.value === undefined || !repo
            ? undefined
            : policy.value.enabled_repositories === "all"
              ? true
              : policy.value.enabled_repositories === "none"
                ? false
                : listed?.value?.some((item) => item.name.toLowerCase() === repo.name.toLowerCase())
        const organizationNotes = [...policy.notes, ...(listed?.notes ?? []), ...billing.notes]
        const exclusion = yield* api
          .json<Record<string, ReadonlyArray<string>>>("GET", `/orgs/${org}/copilot/content_exclusion`)
          .pipe(
            Effect.map((rules) => ({
              available: true,
              rules: Object.fromEntries(Object.entries(rules).map(([key, paths]) => [key, [...paths]])),
            })),
            Effect.catchIf(soft, (error) =>
              Effect.succeed({
                available: false,
                reason: `${message(error)}. Reading content exclusion needs organization owner access and the copilot token scope: run \`gh auth refresh -s copilot\`.`,
              }),
            ),
          )
        return {
          cloud_agent: cloudAgent,
          organization: {
            available: policy.value !== undefined || billing.value !== undefined,
            ...(policy.value === undefined && billing.value === undefined
              ? { reason: "the account cannot read this organization's Copilot settings" }
              : {}),
            org: found.org,
            ...defined({
              enabled_repositories: policy.value?.enabled_repositories,
              repository_enabled: repositoryEnabled,
              plan_type: billing.value?.plan_type,
              seat_breakdown: billing.value?.seat_breakdown,
            }),
            notes: organizationNotes,
          },
          content_exclusion: exclusion,
          note: "Copilot code review on push is configured through rulesets (rule type copilot_code_review); see the rulesets tool.",
        }
      }),
  })

  const copilotSettingsUpdate = GitHubShared.define(deps, {
    name: "copilot_settings_update",
    description: [
      "Change organization Copilot settings: which repositories the cloud agent may work in, and content exclusion.",
      "content_exclusion replaces all of the organization's rules. Repository cloud agent configuration is read-only in the API.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      org: Opt(Schema.String).annotate({ description: "Organization. Defaults to the repository owner." }),
      enabled_repositories: Opt(Schema.Literals(["all", "selected", "none"])).annotate({
        description: "Which repositories the Copilot cloud agent may work in.",
      }),
      enable_repository: Opt(Schema.String).annotate({
        description: 'Repository name in the organization to add to the "selected" list.',
      }),
      disable_repository: Opt(Schema.String).annotate({
        description: 'Repository name in the organization to remove from the "selected" list.',
      }),
      content_exclusion: Opt(Schema.Record(Schema.String, StringList)).annotate({
        description:
          'Paths Copilot must ignore, keyed by repository name or "*" for all; replaces every existing rule. Needs the copilot token scope.',
      }),
    }),
    output: Schema.Struct({ changed: StringList }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const changed = (
          ["enabled_repositories", "enable_repository", "disable_repository", "content_exclusion"] as const
        ).filter((key) => input[key] !== undefined)
        if (changed.length === 0) return yield* invalid("Nothing to change; pass at least one setting.")
        const found = yield* organization(deps, input)
        const api = found.api
        const org = enc(found.org)
        yield* GitHubShared.authorize(deps, context, "copilot_settings_update", orgRef(api, found.org), { changed })
        const base = `/orgs/${org}/copilot/coding-agent/permissions`
        if (input.enabled_repositories !== undefined)
          yield* api.request("PUT", base, { body: { enabled_repositories: input.enabled_repositories } })
        const repositoryId = (name: string) =>
          api
            .json<{ id: number }>("GET", `/repos/${org}/${enc(name.replace(/^[^/]+\//, ""))}`)
            .pipe(Effect.map((repo) => repo.id))
        if (input.enable_repository !== undefined)
          yield* api.request("PUT", `${base}/repositories/${yield* repositoryId(input.enable_repository)}`)
        if (input.disable_repository !== undefined)
          yield* api.request("DELETE", `${base}/repositories/${yield* repositoryId(input.disable_repository)}`)
        if (input.content_exclusion !== undefined)
          yield* api.request("PUT", `/orgs/${org}/copilot/content_exclusion`, { body: input.content_exclusion }).pipe(
            Effect.mapError((error) =>
              error.kind === "forbidden" || error.kind === "not_found"
                ? new GitHubClient.Error({
                    kind: error.kind,
                    message: error.message,
                    ...(error.status === undefined ? {} : { status: error.status }),
                    hint: "Content exclusion needs organization owner access and the copilot token scope: run `gh auth refresh -s copilot`.",
                  })
                : error,
            ),
          )
        return { changed: [...changed] }
      }),
  })

  return [
    actionsSettings,
    actionsSettingsUpdate,
    webhooks,
    webhookUpdate,
    pages,
    pagesUpdate,
    tags,
    tagUpdate,
    copilotSettings,
    copilotSettingsUpdate,
  ]
}
