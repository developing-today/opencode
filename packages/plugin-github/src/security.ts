export * as GitHubSecurity from "./security.js"

import { Effect, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api
type Kind = "dependabot" | "code_scanning" | "secret_scanning"

const Opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(schema)
const StringList = Schema.Array(Schema.String)

const Unavailable = Schema.Struct({ available: Schema.Literal(false), reason: Schema.String })
const Count = Schema.Union([Schema.Int, Schema.String, Unavailable])
const KindField = Schema.Literals(["dependabot", "code_scanning", "secret_scanning"])

const invalid = (message: string, hint?: string) =>
  new GitHubClient.Error({ kind: "validation", message, ...(hint ? { hint } : {}) })

const ALERT_UNAVAILABLE = "not enabled or requires security access"
const unavailable = (status: number, missing = "not enabled or not visible to this account") => ({
  available: false as const,
  reason: status === 403 ? "requires admin or security access" : missing,
})

const PATHS: Record<Kind, string> = {
  dependabot: "dependabot/alerts",
  code_scanning: "code-scanning/alerts",
  secret_scanning: "secret-scanning/alerts",
}

/** Settings carried in the repository's security_and_analysis object, toggled with one PATCH. */
const ANALYSIS = [
  "advanced_security",
  "code_security",
  "secret_scanning",
  "secret_scanning_push_protection",
  "secret_scanning_non_provider_patterns",
  "secret_scanning_validity_checks",
] as const

const STATES: Record<Kind, ReadonlyArray<string>> = {
  dependabot: ["open", "dismissed", "fixed", "auto_dismissed"],
  code_scanning: ["open", "dismissed", "fixed", "closed"],
  secret_scanning: ["open", "resolved"],
}

const REASONS: Record<Kind, ReadonlyArray<string>> = {
  dependabot: ["fix_started", "inaccurate", "no_bandwidth", "not_used", "tolerable_risk"],
  code_scanning: ["false positive", "won't fix", "used in tests"],
  secret_scanning: ["false_positive", "wont_fix", "revoked", "used_in_tests"],
}

/** The state that closes an alert of each kind. */
const CLOSED: Record<Kind, string> = {
  dependabot: "dismissed",
  code_scanning: "dismissed",
  secret_scanning: "resolved",
}

// Severity filters per kind; code scanning accepts both its rule severities and security severities.
const SEVERITIES: Record<Kind, ReadonlyArray<string>> = {
  dependabot: ["low", "medium", "high", "critical"],
  code_scanning: ["critical", "high", "medium", "low", "warning", "note", "error"],
  secret_scanning: [],
}

const FILTERS: Record<
  Kind,
  ReadonlyArray<"ecosystem" | "package" | "scope" | "tool" | "ref" | "secret_type" | "validity">
> = {
  dependabot: ["ecosystem", "package", "scope"],
  code_scanning: ["tool", "ref"],
  secret_scanning: ["secret_type", "validity"],
}

const enabled = (value: boolean) => (value ? "enabled" : "disabled")

/** Counts open alerts from one page of 100, reporting "100+" when GitHub links a further page. */
const openCount = (api: Api, slug: string, kind: Kind) =>
  api
    .request<ReadonlyArray<unknown>>("GET", `/repos/${slug}/${PATHS[kind]}`, {
      query: { state: "open", per_page: 100, ...(kind === "secret_scanning" ? { hide_secret: true } : {}) },
      allow: [403, 404],
    })
    .pipe(
      Effect.map((response) => {
        if (response.status >= 400) return unavailable(response.status, ALERT_UNAVAILABLE)
        const count = Array.isArray(response.data) ? response.data.length : 0
        return GitHubClient.nextLink(response.headers.link) ? `${count}+` : count
      }),
    )

interface DependabotAlert {
  readonly number: number
  readonly state: string
  readonly created_at: string
  readonly html_url: string
  readonly dismissed_reason?: string | null
  readonly dismissed_comment?: string | null
  readonly dependency?: {
    readonly package?: { readonly ecosystem?: string; readonly name?: string }
    readonly manifest_path?: string
    readonly scope?: string | null
  }
  readonly security_advisory?: { readonly summary?: string; readonly severity?: string }
  readonly security_vulnerability?: { readonly severity?: string }
}

interface CodeScanningAlert {
  readonly number: number
  readonly state: string
  readonly created_at: string
  readonly html_url: string
  readonly dismissed_reason?: string | null
  readonly dismissed_comment?: string | null
  readonly rule?: {
    readonly id?: string
    readonly description?: string
    readonly severity?: string | null
    readonly security_severity_level?: string | null
  }
  readonly tool?: { readonly name?: string }
  readonly most_recent_instance?: { readonly location?: { readonly path?: string; readonly start_line?: number } }
}

interface SecretScanningAlert {
  readonly number: number
  readonly state: string
  readonly created_at: string
  readonly html_url: string
  readonly secret_type?: string
  readonly secret_type_display_name?: string
  readonly validity?: string
  readonly resolution?: string | null
  readonly resolution_comment?: string | null
  readonly first_location_detected?: { readonly path?: string; readonly start_line?: number } | null
}

const present = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value === undefined || value === null ? {} : { [key]: value }) as Partial<Record<K, V>>

const dependabotItem = (alert: DependabotAlert) => ({
  number: alert.number,
  state: alert.state,
  ...present("severity", alert.security_vulnerability?.severity ?? alert.security_advisory?.severity),
  title: alert.security_advisory?.summary ?? "",
  ...present("package", alert.dependency?.package?.name),
  ...present("ecosystem", alert.dependency?.package?.ecosystem),
  ...present("manifest", alert.dependency?.manifest_path),
  ...present("scope", alert.dependency?.scope),
  created_at: alert.created_at,
  url: alert.html_url,
  ...present("dismissed_reason", alert.dismissed_reason),
  ...present("comment", alert.dismissed_comment),
})

const codeScanningItem = (alert: CodeScanningAlert) => ({
  number: alert.number,
  state: alert.state,
  ...present("severity", alert.rule?.security_severity_level ?? alert.rule?.severity),
  title: alert.rule?.description ?? alert.rule?.id ?? "",
  ...present("rule", alert.rule?.id),
  ...present("tool", alert.tool?.name),
  ...present("path", alert.most_recent_instance?.location?.path),
  ...present("line", alert.most_recent_instance?.location?.start_line),
  created_at: alert.created_at,
  url: alert.html_url,
  ...present("dismissed_reason", alert.dismissed_reason),
  ...present("comment", alert.dismissed_comment),
})

// Built field by field so the alert's `secret` value can never reach the output.
const secretScanningItem = (alert: SecretScanningAlert) => ({
  number: alert.number,
  state: alert.state,
  title: alert.secret_type_display_name ?? alert.secret_type ?? "",
  ...present("secret_type", alert.secret_type),
  ...present("validity", alert.validity),
  ...present("path", alert.first_location_detected?.path),
  ...present("line", alert.first_location_detected?.start_line),
  created_at: alert.created_at,
  url: alert.html_url,
  ...present("resolution", alert.resolution),
  ...present("comment", alert.resolution_comment),
})

const AlertItem = Schema.Struct({
  number: Schema.Int,
  state: Schema.String,
  severity: Opt(Schema.String),
  title: Schema.String,
  package: Opt(Schema.String),
  ecosystem: Opt(Schema.String),
  manifest: Opt(Schema.String),
  scope: Opt(Schema.String),
  rule: Opt(Schema.String),
  tool: Opt(Schema.String),
  secret_type: Opt(Schema.String),
  validity: Opt(Schema.String),
  path: Opt(Schema.String),
  line: Opt(Schema.Int),
  created_at: Schema.String,
  url: Schema.String,
  dismissed_reason: Opt(Schema.String),
  resolution: Opt(Schema.String),
  comment: Opt(Schema.String),
})

export function tools(deps: Deps) {
  const security = GitHubShared.define(deps, {
    name: "security",
    description: [
      "A repository's security settings: GitHub Advanced Security features, Dependabot, code scanning default setup.",
      "Also private vulnerability reporting, the attached code security configuration and open alert counts per kind.",
      "Parts the account cannot read (most need admin or security manager access) report available: false.",
    ].join("\n"),
    input: Schema.Struct({ repo: GitHubShared.RepoField }),
    output: Schema.Struct({
      repo: Schema.String,
      security_and_analysis: Schema.Union([Schema.Record(Schema.String, Schema.String), Unavailable]),
      dependabot_alerts: Schema.Union([Schema.Struct({ enabled: Schema.Boolean }), Unavailable]),
      dependabot_security_updates: Schema.Union([
        Schema.Struct({ enabled: Schema.Boolean, paused: Opt(Schema.Boolean) }),
        Unavailable,
      ]),
      private_vulnerability_reporting: Schema.Union([Schema.Struct({ enabled: Schema.Boolean }), Unavailable]),
      code_scanning_default_setup: Schema.Union([
        Schema.Struct({
          state: Schema.String,
          languages: StringList,
          query_suite: Opt(Schema.String),
          updated_at: Opt(Schema.String),
          schedule: Opt(Schema.String),
        }),
        Unavailable,
      ]),
      code_security_configuration: Schema.Union([
        Schema.Struct({
          status: Schema.String,
          configuration: Opt(Schema.Struct({ id: Schema.Int, name: Schema.String })),
        }),
        Unavailable,
      ]).annotate({ description: 'status "none" when no configuration is attached.' }),
      open_alerts: Schema.Struct({ dependabot: Count, code_scanning: Count, secret_scanning: Count }),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        const get = <A>(path: string) => api.request<A>("GET", `/repos/${slug}${path}`, { allow: [403, 404] })
        const [info, alerts, fixes, reporting, setup, configuration, dependabot, codeScanning, secretScanning] =
          yield* Effect.all(
            [
              api.json<{
                security_and_analysis?: Record<string, { status?: string } | null> | null
                permissions?: { admin?: boolean }
              }>("GET", `/repos/${slug}`),
              get<unknown>("/vulnerability-alerts"),
              get<{ enabled: boolean; paused?: boolean }>("/automated-security-fixes"),
              get<{ enabled: boolean }>("/private-vulnerability-reporting"),
              get<{
                state: string
                languages?: ReadonlyArray<string>
                query_suite?: string | null
                updated_at?: string | null
                schedule?: string | null
              }>("/code-scanning/default-setup"),
              get<{ status?: string; configuration?: { id: number; name: string } | null } | undefined>(
                "/code-security-configuration",
              ),
              openCount(api, slug, "dependabot"),
              openCount(api, slug, "code_scanning"),
              openCount(api, slug, "secret_scanning"),
            ],
            { concurrency: 5 },
          )
        const analysis = info.security_and_analysis
        return {
          repo: slug,
          // GitHub only includes security_and_analysis for accounts with admin access to the repository.
          security_and_analysis: analysis
            ? Object.fromEntries(
                Object.entries(analysis).flatMap(([key, value]) =>
                  value?.status === undefined ? [] : [[key, value.status]],
                ),
              )
            : { available: false as const, reason: "requires admin access" },
          // The check answers 404 both when alerts are off and when the account is not an admin.
          dependabot_alerts:
            alerts.status === 403 || (alerts.status === 404 && info.permissions?.admin !== true)
              ? unavailable(403)
              : { enabled: alerts.status !== 404 },
          dependabot_security_updates:
            fixes.status >= 400
              ? unavailable(fixes.status)
              : {
                  enabled: fixes.data.enabled,
                  ...present("paused", fixes.data.paused),
                },
          private_vulnerability_reporting:
            reporting.status >= 400 ? unavailable(reporting.status) : { enabled: reporting.data.enabled },
          code_scanning_default_setup:
            setup.status >= 400
              ? unavailable(setup.status)
              : {
                  state: setup.data.state,
                  languages: [...(setup.data.languages ?? [])],
                  ...present("query_suite", setup.data.query_suite),
                  ...present("updated_at", setup.data.updated_at),
                  ...present("schedule", setup.data.schedule),
                },
          code_security_configuration:
            configuration.status >= 400
              ? unavailable(configuration.status)
              : {
                  status: configuration.data?.status ?? "none",
                  ...(configuration.data?.configuration
                    ? {
                        configuration: {
                          id: configuration.data.configuration.id,
                          name: configuration.data.configuration.name,
                        },
                      }
                    : {}),
                },
          open_alerts: { dependabot, code_scanning: codeScanning, secret_scanning: secretScanning },
        }
      }),
  })

  const securityUpdate = GitHubShared.define(deps, {
    name: "security_update",
    description: [
      "Turn repository security features on or off: Advanced Security, secret scanning, push protection, Dependabot.",
      "Also private vulnerability reporting and code scanning default setup. Needs admin access; pass only what changes.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      advanced_security: Opt(Schema.Boolean),
      code_security: Opt(Schema.Boolean),
      secret_scanning: Opt(Schema.Boolean),
      secret_scanning_push_protection: Opt(Schema.Boolean),
      secret_scanning_non_provider_patterns: Opt(Schema.Boolean),
      secret_scanning_validity_checks: Opt(Schema.Boolean),
      dependabot_alerts: Opt(Schema.Boolean),
      dependabot_security_updates: Opt(Schema.Boolean).annotate({ description: "Needs Dependabot alerts enabled." }),
      private_vulnerability_reporting: Opt(Schema.Boolean),
      code_scanning_default_setup: Opt(Schema.Literals(["configured", "not-configured"])),
      query_suite: Opt(Schema.Literals(["default", "extended"])).annotate({
        description: "Code scanning default setup query suite.",
      }),
    }),
    output: Schema.Struct({ changed: StringList }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const analysis = ANALYSIS.flatMap((key) => {
          const value = input[key]
          return value === undefined ? [] : [[key, { status: enabled(value) }] as const]
        })
        const setup = {
          ...present("state", input.code_scanning_default_setup),
          ...present("query_suite", input.query_suite),
        }
        const toggles = (
          ["dependabot_alerts", "dependabot_security_updates", "private_vulnerability_reporting"] as const
        ).filter((key) => input[key] !== undefined)
        const changed = [...analysis.map((entry) => entry[0]), ...toggles, ...Object.keys(setup).map(setupName)]
        if (changed.length === 0) return yield* invalid("Nothing to change; pass at least one setting.")
        if (input.query_suite !== undefined && input.code_scanning_default_setup === "not-configured")
          return yield* invalid('query_suite cannot be set while turning default setup "not-configured".')
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const api = resolved.api
        const slug = GitHubRepo.slug(resolved.repo)
        yield* GitHubShared.authorize(deps, context, "security_update", resolved.repo, { changed })
        const toggle = (path: string, value: boolean | undefined) =>
          value === undefined ? Effect.void : api.request(value ? "PUT" : "DELETE", `/repos/${slug}/${path}`)
        // Advanced Security goes first because code scanning default setup needs it on private repositories.
        if (analysis.length > 0)
          yield* api.request("PATCH", `/repos/${slug}`, {
            body: { security_and_analysis: Object.fromEntries(analysis) },
          })
        const alerts = toggle("vulnerability-alerts", input.dependabot_alerts)
        const fixes = toggle("automated-security-fixes", input.dependabot_security_updates)
        // Security updates need alerts: enable alerts before updates, and disable updates before alerts.
        yield* input.dependabot_alerts === false ? Effect.andThen(fixes, alerts) : Effect.andThen(alerts, fixes)
        yield* toggle("private-vulnerability-reporting", input.private_vulnerability_reporting)
        if (Object.keys(setup).length > 0)
          yield* api.request("PATCH", `/repos/${slug}/code-scanning/default-setup`, { body: setup })
        return { changed }
      }),
  })

  const alerts = GitHubShared.define(deps, {
    name: "alerts",
    description: [
      "Repository-wide Dependabot, code scanning or secret scanning alerts, newest first. Secret values are never returned.",
      'Default state "open". Filters apply per kind: dependabot severity/ecosystem/package/scope; code scanning',
      "severity/tool/ref; secret scanning secret_type/validity. For alerts on one pull request use feedback.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      kind: KindField,
      state: Opt(Schema.String).annotate({
        description:
          "dependabot: open|dismissed|fixed|auto_dismissed; code_scanning: open|dismissed|fixed|closed; secret_scanning: open|resolved.",
      }),
      severity: Opt(Schema.String).annotate({
        description:
          "dependabot: low|medium|high|critical; code_scanning: critical|high|medium|low|warning|note|error.",
      }),
      ecosystem: Opt(Schema.String).annotate({ description: "Dependabot: npm, pip, maven, …" }),
      package: Opt(Schema.String).annotate({ description: "Dependabot: package name." }),
      scope: Opt(Schema.Literals(["development", "runtime"])).annotate({ description: "Dependabot." }),
      tool: Opt(Schema.String).annotate({ description: "Code scanning: tool name, such as CodeQL." }),
      ref: Opt(Schema.String).annotate({ description: "Code scanning: branch or refs/pull/N/head." }),
      secret_type: Opt(Schema.String).annotate({ description: "Secret scanning: comma-separated secret types." }),
      validity: Opt(Schema.String).annotate({ description: "Secret scanning: active|inactive|unknown." }),
      limit: GitHubShared.limit(300, 30),
    }),
    output: Schema.Union([
      Schema.Struct({
        kind: KindField,
        total: Schema.Union([Schema.Int, Schema.String]).annotate({
          description: 'Alerts matching, or "N+" when more exist than were returned.',
        }),
        items: Schema.Array(AlertItem),
      }),
      Schema.Struct({ kind: KindField, available: Schema.Literal(false), reason: Schema.String }),
    ]),
    execute: (input) =>
      Effect.gen(function* () {
        const kind = input.kind
        const state = input.state ?? "open"
        if (!STATES[kind].includes(state))
          return yield* invalid(`state for ${kind} must be one of: ${STATES[kind].join(", ")}.`)
        if (input.severity !== undefined && !SEVERITIES[kind].includes(input.severity))
          return yield* invalid(
            SEVERITIES[kind].length === 0
              ? `${kind} alerts have no severity filter.`
              : `severity for ${kind} must be one of: ${SEVERITIES[kind].join(", ")}.`,
          )
        const stray = (["ecosystem", "package", "scope", "tool", "ref", "secret_type", "validity"] as const).filter(
          (key) => input[key] !== undefined && !FILTERS[kind].includes(key),
        )
        if (stray.length > 0) return yield* invalid(`${stray.join(", ")} do not apply to ${kind} alerts.`)
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        const limit = input.limit ?? 30
        const query = {
          state,
          ...present("severity", input.severity),
          ...present("ecosystem", input.ecosystem),
          ...present("package", input.package),
          ...present("scope", input.scope),
          ...present("tool_name", input.tool),
          ...present("ref", input.ref),
          ...present("secret_type", input.secret_type),
          ...present("validity", input.validity),
          ...(kind === "secret_scanning" ? { hide_secret: true } : {}),
        }
        // One extra item tells whether more alerts exist than the limit.
        const listed = yield* resolved.api
          .paginate<DependabotAlert & CodeScanningAlert & SecretScanningAlert>(`/repos/${slug}/${PATHS[kind]}`, {
            query,
            limit: limit + 1,
          })
          .pipe(
            Effect.map((items) => ({ items })),
            Effect.catchIf(
              (error) => error.kind === "forbidden" || error.kind === "not_found",
              () => Effect.succeed(undefined),
            ),
          )
        if (!listed) return { kind, available: false as const, reason: ALERT_UNAVAILABLE }
        const view =
          kind === "dependabot" ? dependabotItem : kind === "code_scanning" ? codeScanningItem : secretScanningItem
        const items = listed.items.slice(0, limit).map(view)
        return { kind, total: listed.items.length > limit ? `${limit}+` : items.length, items }
      }),
  })

  const alertUpdate = GitHubShared.define(deps, {
    name: "alert_update",
    description: [
      "Dismiss, resolve or reopen one Dependabot, code scanning or secret scanning alert.",
      'Close with state "dismissed" (dependabot, code_scanning) or "resolved" (secret_scanning) and a reason; reopen with "open".',
      "Reasons: dependabot fix_started|inaccurate|no_bandwidth|not_used|tolerable_risk; code_scanning",
      '"false positive"|"won\'t fix"|"used in tests"; secret_scanning false_positive|wont_fix|revoked|used_in_tests.',
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      kind: KindField,
      number: Schema.Int.check(Schema.isGreaterThan(0)),
      state: Schema.Literals(["dismissed", "resolved", "open"]),
      reason: Opt(Schema.String).annotate({ description: "Required when dismissing or resolving." }),
      comment: Opt(Schema.String).annotate({
        description: "Why; dependabot and code scanning keep the first 280 characters.",
      }),
    }),
    output: Schema.Struct({ kind: KindField, number: Schema.Int, state: Schema.String }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const kind = input.kind
        const closing = input.state !== "open"
        if (closing && input.state !== CLOSED[kind])
          return yield* invalid(`${kind} alerts close with state "${CLOSED[kind]}", not "${input.state}".`)
        if (!closing && (input.reason !== undefined || input.comment !== undefined))
          return yield* invalid("reason and comment only apply when closing an alert.")
        if (closing && (input.reason === undefined || !REASONS[kind].includes(input.reason)))
          return yield* invalid(`reason for ${kind} must be one of: ${REASONS[kind].join(", ")}.`)
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        yield* GitHubShared.authorize(deps, context, "alert_update", resolved.repo, {
          kind,
          number: input.number,
          state: input.state,
          ...present("reason", input.reason),
        })
        // Dependabot and code scanning reject dismissal comments over 280 characters.
        const comment = kind === "secret_scanning" ? input.comment : input.comment?.slice(0, 280)
        const body = !closing
          ? { state: "open" }
          : kind === "secret_scanning"
            ? { state: input.state, resolution: input.reason, ...present("resolution_comment", comment) }
            : { state: input.state, dismissed_reason: input.reason, ...present("dismissed_comment", comment) }
        const updated = yield* resolved.api.json<{ state?: string } | undefined>(
          "PATCH",
          `/repos/${slug}/${PATHS[kind]}/${input.number}`,
          { body },
        )
        return { kind, number: input.number, state: updated?.state ?? input.state }
      }),
  })

  return [security, securityUpdate, alerts, alertUpdate]
}

const setupName = (key: string) => (key === "state" ? "code_scanning_default_setup" : key)
