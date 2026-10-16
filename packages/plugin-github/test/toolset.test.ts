import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GitHubTools } from "../src/index.js"
import { GitHubToolset } from "../src/toolset.js"
import { fakeGitHub, find, makeDeps, run } from "./fixture"
import { it, withEnv } from "./lib"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }

describe("GitHubToolset.select", () => {
  const names = ["secrets", "secret_set", "variables", "variable_set", "alerts", "alert_update", "repo_update", "pr"]

  test("matches tool names, sections and aliases with wildcards, ignoring case", () => {
    expect([...GitHubToolset.select(["secret*"], names)].toSorted()).toEqual(["secret_set", "secrets"])
    expect([...GitHubToolset.select(["*_set", "*_UPDATE"], names)].toSorted()).toEqual([
      "alert_update",
      "repo_update",
      "secret_set",
      "variable_set",
    ])
    // dependabot is an alias of the secrets and alerts sections (and security, absent from this list).
    expect([...GitHubToolset.select(["dependabot"], names)].toSorted()).toEqual([
      "alert_update",
      "alerts",
      "secret_set",
      "secrets",
    ])
    expect(GitHubToolset.select(["nothing*"], names).size).toBe(0)
  })

  test("every registered tool belongs to exactly one section", () => {
    const sectioned = GitHubToolset.SECTIONS.flatMap((section) => section.tools)
    expect(new Set(sectioned).size).toBe(sectioned.length)
  })
})

describe("github toolset tools", () => {
  it.live("administration tools start hidden; enable and disable change what is shown, persist, and reload", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { deps, kv } = yield* makeDeps({ http: fakeGitHub({}).http })
        const registered = GitHubTools.tools(deps)
        // A tool missing from SECTIONS would be shown by default without anyone deciding so.
        const sectioned = GitHubToolset.SECTIONS.flatMap((section) => section.tools)
        expect(registered.map((tool) => tool.name).filter((name) => !sectioned.includes(name))).toEqual([])
        let reloads = 0
        const toolset = GitHubToolset.make({
          deps,
          tools: registered,
          reload: () => Effect.sync(() => void reloads++),
          project: "project-a",
        })
        yield* toolset.load
        expect(toolset.enabled("feedback")).toBe(true)
        expect(toolset.enabled("secret_set")).toBe(false)
        expect(toolset.enabled("list_tools")).toBe(true)

        const enabled = yield* run<object, { changed: string[]; unmatched: string[] }>(find(toolset.meta, "enable"), {
          patterns: ["secret*", "variables", "nope"],
        })
        expect(enabled.changed.toSorted()).toEqual(["secret_set", "secrets", "variable_set", "variables"])
        expect(enabled.unmatched).toEqual(["nope"])
        expect(reloads).toBe(1)
        expect(toolset.enabled("secret_set")).toBe(true)

        const disabled = yield* run<object, { changed: string[] }>(find(toolset.meta, "disable"), {
          patterns: ["*_set"],
        })
        // property_set was already hidden, so only the two shown _set tools change.
        expect(disabled.changed.toSorted()).toEqual(["secret_set", "variable_set"])
        expect(toolset.enabled("secrets")).toBe(true)
        expect(toolset.enabled("secret_set")).toBe(false)

        // A second load for the same directory, as after a restart, sees the same state.
        const again = GitHubToolset.make({ deps, tools: registered, reload: () => Effect.void, project: "project-a" })
        yield* again.load
        expect(again.enabled("secrets")).toBe(true)
        expect(again.enabled("secret_set")).toBe(false)

        const listed = yield* run<
          object,
          {
            sections: Array<{
              name: string
              aliases: string[]
              enabled: number
              tools: Array<{ name: string; enabled: boolean; summary?: string }>
            }>
          }
        >(find(toolset.meta, "list_tools"), { filter: "secret*" })
        expect(listed.sections).toEqual([
          {
            name: "secrets",
            aliases: ["admin", "settings", "dependabot", "codespaces"],
            enabled: 1,
            tools: [
              { name: "secrets", enabled: true },
              {
                name: "secret_set",
                enabled: false,
                summary:
                  "Set or delete one GitHub secret (Actions, Dependabot, Codespaces) in a repository, environment or organization.",
              },
            ],
          },
        ])

        yield* run(find(toolset.meta, "list_tools"), { reset: true })
        expect(toolset.enabled("secrets")).toBe(false)
        expect(yield* kv.get("github.toolset/project-a")).toBeUndefined()
      }),
    ),
  )

  it.live("checkouts of one project share changes live and reload each other; other projects are untouched", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { deps, kv } = yield* makeDeps({ http: fakeGitHub({}).http })
        const registered = GitHubTools.tools(deps)
        const reloads: string[] = []
        const instance = (project: string, label: string) =>
          GitHubToolset.make({
            deps,
            tools: registered,
            reload: () => Effect.sync(() => void reloads.push(label)),
            project,
          })
        const main = instance("project-shared", "main")
        const worktree = instance("project-shared", "worktree")
        const other = instance("project-other", "other")
        yield* Effect.all([main.load, worktree.load, other.load])

        yield* run(find(worktree.meta, "enable"), { patterns: ["webhooks"] })
        expect(main.enabled("webhook_update")).toBe(true)
        expect(other.enabled("webhook_update")).toBe(false)
        expect(reloads.toSorted()).toEqual(["main", "worktree"])
        expect(yield* kv.get("github.toolset/project-shared")).toEqual({ webhooks: true, webhook_update: true })
      }),
    ),
  )

  test("scopeOf uses the project ID, and the directory for the shared global project", () => {
    expect(GitHubToolset.scopeOf({ directory: "/repo/.worktrees/a", project: { id: "abc123" } })).toBe("abc123")
    expect(GitHubToolset.scopeOf({ directory: "/scratch", project: { id: "global" } })).toBe("/scratch")
  })

  it.live("preferences choose which tools a working directory starts with", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const { deps, kv } = yield* makeDeps({ http: fakeGitHub({}).http })
        yield* kv.set("github.preferences/global", { tools_enabled: ["admin"], tools_disabled: ["*_update", "*_set"] })
        const toolset = GitHubToolset.make({
          deps,
          tools: GitHubTools.tools(deps),
          reload: () => Effect.void,
          project: "project-b",
        })
        yield* toolset.load
        expect(toolset.enabled("environments")).toBe(true)
        expect(toolset.enabled("environment_update")).toBe(false)
        expect(toolset.enabled("pr_update")).toBe(false)
        expect(toolset.enabled("pr")).toBe(true)
      }),
    ),
  )
})
