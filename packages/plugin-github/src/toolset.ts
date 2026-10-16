export * as GitHubToolset from "./toolset.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema, Scope } from "effect"
import { GitHubPreferences } from "./preferences.js"
import { GitHubShared } from "./shared.js"

export interface Section {
  readonly name: string
  readonly tools: ReadonlyArray<string>
  /** Listed to the model from the start. Everything else waits until `enable` adds it. */
  readonly visible: boolean
  readonly aliases?: ReadonlyArray<string>
}

export const SECTIONS: ReadonlyArray<Section> = [
  {
    name: "review",
    visible: true,
    tools: ["context", "preferences", "pr", "feedback", "respond", "updates", "copilot", "wait"],
  },
  { name: "pulls", visible: true, tools: ["prs", "pr_create", "pr_update", "pr_merge", "pr_files", "review"] },
  {
    name: "issues",
    visible: true,
    tools: ["issues", "issue", "issue_create", "issue_update", "comment", "comment_update"],
  },
  {
    name: "discussions",
    visible: true,
    tools: ["discussions", "discussion", "discussion_create", "discussion_update"],
  },
  {
    name: "actions",
    visible: true,
    tools: ["workflows", "runs", "run", "logs", "run_action", "dispatch", "artifacts", "artifact_download"],
  },
  {
    name: "releases",
    visible: true,
    tools: ["releases", "release_create", "release_update", "release_notes", "release_asset"],
  },
  { name: "explore", visible: true, tools: ["repo", "search", "commits", "compare", "repos", "upload", "api"] },
  { name: "repo_settings", visible: false, tools: ["repo_update"], aliases: ["admin", "settings"] },
  {
    name: "access",
    visible: false,
    tools: ["collaborators", "collaborator_update"],
    aliases: ["admin", "collaborators", "teams", "roles"],
  },
  { name: "properties", visible: false, tools: ["properties", "property_set"], aliases: ["admin", "settings"] },
  { name: "variables", visible: false, tools: ["variables", "variable_set"], aliases: ["admin", "settings"] },
  {
    name: "secrets",
    visible: false,
    tools: ["secrets", "secret_set"],
    aliases: ["admin", "settings", "dependabot", "codespaces"],
  },
  {
    name: "environments",
    visible: false,
    tools: ["environments", "environment_update"],
    aliases: ["admin", "settings", "deployments"],
  },
  {
    name: "rulesets",
    visible: false,
    tools: ["rulesets", "ruleset_update"],
    aliases: ["admin", "settings", "protection"],
  },
  {
    name: "branch_protection",
    visible: false,
    tools: ["branch_protection", "branch_protection_update"],
    aliases: ["admin", "settings", "protection", "branches"],
  },
  { name: "tags", visible: false, tools: ["tags", "tag_update"], aliases: ["admin", "settings"] },
  {
    name: "actions_settings",
    visible: false,
    tools: ["actions_settings", "actions_settings_update"],
    aliases: ["admin", "settings", "runners", "oidc"],
  },
  { name: "webhooks", visible: false, tools: ["webhooks", "webhook_update"], aliases: ["admin", "settings", "hooks"] },
  { name: "pages", visible: false, tools: ["pages", "pages_update"], aliases: ["admin", "settings"] },
  {
    name: "deploy_keys",
    visible: false,
    tools: ["deploy_keys", "deploy_key_update"],
    aliases: ["admin", "settings", "keys"],
  },
  { name: "autolinks", visible: false, tools: ["autolinks", "autolink_update"], aliases: ["admin", "settings"] },
  {
    name: "security",
    visible: false,
    tools: ["security", "security_update"],
    aliases: ["admin", "settings", "dependabot"],
  },
  {
    name: "alerts",
    visible: false,
    tools: ["alerts", "alert_update"],
    aliases: ["dependabot", "code_scanning", "secret_scanning", "codeql"],
  },
  {
    name: "copilot_settings",
    visible: false,
    tools: ["copilot_settings", "copilot_settings_update"],
    aliases: ["admin", "settings", "copilot"],
  },
]

export const META = "toolset"

/** A case-insensitive glob: `*` matches any run of characters and `?` one. */
export function matcher(pattern: string) {
  const source = pattern
    .trim()
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  const regex = new RegExp(`^${source}$`)
  return (value: string) => regex.test(value.toLowerCase())
}

/**
 * Tool names a pattern selects: matching tool names, every tool of a matching section, and every tool of a section
 * with that exact alias. Aliases take no wildcards, so `secret*` means the secrets tools, not secret scanning alerts.
 */
export function select(patterns: ReadonlyArray<string>, names: ReadonlyArray<string>) {
  return new Set(
    patterns.flatMap((pattern) => {
      const matches = matcher(pattern)
      const alias = pattern.trim().toLowerCase()
      const sections = SECTIONS.filter(
        (section) => matches(section.name) || (section.aliases ?? []).includes(alias),
      ).flatMap((section) => section.tools)
      return [...names.filter((name) => matches(name)), ...sections].filter((name) => names.includes(name))
    }),
  )
}

const Overrides = Schema.Record(Schema.String, Schema.Boolean)
const decodeOverrides = Schema.decodeUnknownOption(Overrides)

const Patterns = Schema.Array(Schema.String)

const Input = Schema.Struct({
  enable: Schema.optionalKey(Patterns).annotate({
    description:
      'Show these: tool names, section names or section aliases, with * and ? wildcards: ["dependabot", "secret*"].',
  }),
  disable: Schema.optionalKey(Patterns).annotate({
    description: 'Hide these, before enable applies: ["*_set", "*_update"], or ["*"] to start from nothing.',
  }),
  reset: Schema.optionalKey(Schema.Boolean).annotate({ description: "Return to the defaults first." }),
  list: Schema.optionalKey(Schema.String).annotate({
    description:
      'List sections and tools matching this wildcard ("*" for all). The default when nothing else is asked.',
  }),
})

const Output = Schema.Struct({
  enabled: Schema.Int,
  hidden: Schema.Int,
  changed: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "Tools this call showed or hid." }),
  unmatched: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Patterns that matched nothing.",
  }),
  sections: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        aliases: Schema.Array(Schema.String),
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            enabled: Schema.Boolean,
            summary: Schema.optionalKey(Schema.String).annotate({ description: "Only for hidden tools." }),
          }),
        ),
      }),
    ),
  ),
})

type Reload = Context["tool"]["reload"]

// The plugin runs once per working directory. Instances of one project (its checkouts, worktrees and
// subdirectories) share this state, so a change in one reaches sessions in the others without a restart.
const live = new Map<string, { overrides: Record<string, boolean>; reloads: Set<Reload> }>()
const shared = (project: string) => {
  const found = live.get(project)
  if (found) return found
  const created = { overrides: {} as Record<string, boolean>, reloads: new Set<Reload>() }
  live.set(project, created)
  return created
}

/** The project's ID, so worktrees and clones share one state; the directory where there is none to share. */
export const scopeOf = (location: { readonly directory: string; readonly project: { readonly id: string } }) =>
  location.project.id === "global" ? location.directory : location.project.id

/**
 * Which github tools are listed to the model. Every tool exists either way; hiding only keeps rarely used
 * administration tools out of the tool list until a session needs them. The state belongs to the project, so every
 * session in any of its checkouts sees the same list, and survives restarts in plugin storage.
 */
export function make(input: {
  readonly deps: GitHubShared.Deps
  readonly tools: ReadonlyArray<Tool.Info>
  readonly reload: Reload
  /** See scopeOf. */
  readonly project: string
}) {
  const names = input.tools.map((tool) => tool.name)
  const sectionOf = new Map(SECTIONS.flatMap((section) => section.tools.map((name) => [name, section] as const)))
  const visibleByDefault = (name: string) => sectionOf.get(name)?.visible ?? true
  const key = `github.toolset/${input.project}`
  let state = shared(input.project)
  let defaults: Record<string, boolean> = {}

  const enabled = (name: string) => name === META || (state.overrides[name] ?? defaults[name] ?? visibleByDefault(name))
  const counts = () => {
    const shown = names.filter(enabled).length
    return { enabled: shown, hidden: names.length - shown }
  }
  // The namespace line is in every request, so it carries the review loop's entry points and nothing else.
  const description = () =>
    [
      "GitHub through the signed-in gh account. Review loop: context once, then pr (status), feedback (open items),",
      "respond (reply, resolve, dismiss) and wait (Copilot review or checks, in the background). Also pull requests,",
      "issues, discussions, Actions, releases, repo, search, uploads and api.",
      counts().hidden > 0
        ? `${counts().hidden} administration tools are hidden: toolset() lists them, toolset({ enable }) adds them.`
        : "",
    ]
      .filter((part) => part !== "")
      .join(" ")
  const reloadAll = Effect.suspend(() =>
    Effect.forEach(new Set([input.reload, ...state.reloads]), (reload) => reload(), { discard: true }),
  )

  // Preferences can name tools to show or hide by default, globally or per repository.
  const load = Effect.gen(function* () {
    // Fetched again: the last instance of this project may have closed since make, dropping the shared state.
    state = shared(input.project)
    state.reloads.add(input.reload)
    yield* Scope.addFinalizer(
      input.deps.scope,
      Effect.sync(() => {
        state.reloads.delete(input.reload)
        if (state.reloads.size === 0 && live.get(input.project) === state) live.delete(input.project)
      }),
    )
    state.overrides = Option.getOrElse(decodeOverrides(yield* input.deps.kv.get(key)), () => ({}))
    const target = yield* GitHubShared.target(input.deps).pipe(Effect.option)
    const prefs = yield* GitHubPreferences.effective(input.deps.kv, Option.getOrUndefined(target)?.repo)
    defaults = Object.fromEntries([
      ...[...select(prefs.effective.tools_enabled ?? [], names)].map((name) => [name, true] as const),
      ...[...select(prefs.effective.tools_disabled ?? [], names)].map((name) => [name, false] as const),
    ])
  })

  const listing = (filter: string) => {
    const shown = select([filter], names)
    const byTool = new Map(input.tools.map((tool) => [tool.name, tool]))
    return SECTIONS.map((section) => ({
      name: section.name,
      aliases: [...new Set(section.aliases ?? [])],
      tools: section.tools
        .filter((name) => shown.has(name))
        .map((name) => ({
          name,
          enabled: enabled(name),
          // Shown tools are already described in the tool list; repeat only what the model cannot see.
          ...(enabled(name) ? {} : { summary: byTool.get(name)?.description.split("\n")[0] ?? "" }),
        })),
    })).filter((section) => section.tools.length > 0)
  }

  const toolset = GitHubShared.define(input.deps, {
    name: META,
    description: [
      "List, show or hide github tools to keep the tool list short; hiding restricts nothing. With no arguments, lists",
      "every section with hidden tools summarized. Changes reach every session in this project from its next step.",
      'Example: toolset({ disable: ["*"], enable: ["pr", "feedback", "respond"] }).',
    ].join(" "),
    input: Input,
    output: Output,
    execute: (args) =>
      Effect.gen(function* () {
        const before = names.filter(enabled)
        const asked = args.reset === true || args.enable !== undefined || args.disable !== undefined
        if (args.reset) state.overrides = {}
        const apply = (patterns: ReadonlyArray<string>, value: boolean) => {
          state.overrides = {
            ...state.overrides,
            ...Object.fromEntries([...select(patterns, names)].map((name) => [name, value])),
          }
        }
        apply(args.disable ?? [], false)
        apply(args.enable ?? [], true)
        const after = names.filter(enabled)
        const changed = names.filter((name) => before.includes(name) !== after.includes(name))
        if (asked && Object.keys(state.overrides).length === 0) yield* input.deps.kv.remove(key)
        if (asked && Object.keys(state.overrides).length > 0) yield* input.deps.kv.set(key, state.overrides)
        if (changed.length > 0) yield* reloadAll
        const unmatched = [...(args.disable ?? []), ...(args.enable ?? [])].filter(
          (pattern) => select([pattern], names).size === 0,
        )
        return {
          ...counts(),
          ...(asked ? { changed } : {}),
          ...(unmatched.length > 0 ? { unmatched } : {}),
          ...(args.list !== undefined || !asked ? { sections: listing(args.list ?? "*") } : {}),
        }
      }),
  })

  return { load, enabled, toolset, description, counts }
}
