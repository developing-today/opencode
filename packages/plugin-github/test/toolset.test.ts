import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GitHubTools } from "../src/index.js"
import { GitHubToolset } from "../src/toolset.js"
import { fakeGitHub, makeDeps, run } from "./fixture"
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
  it.live("administration tools start hidden; toolset shows, hides, lists, persists, reloads and resets", () =>
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
        expect(toolset.enabled("toolset")).toBe(true)
        expect(toolset.description()).toContain("33 administration tools are hidden")

        type Result = {
          enabled: number
          hidden: number
          changed?: string[]
          unmatched?: string[]
          sections?: Array<{
            name: string
            aliases: string[]
            tools: Array<{ name: string; enabled: boolean; summary?: string }>
          }>
        }
        const call = (input: object) => run<object, Result>(toolset.toolset, input)

        const shown = yield* call({ enable: ["secret*", "variables", "nope"] })
        expect(shown).toEqual({
          enabled: 48,
          hidden: 29,
          changed: ["variables", "variable_set", "secrets", "secret_set"],
          unmatched: ["nope"],
        })
        expect(reloads).toBe(1)

        // disable applies before enable, so a narrow list can be built in one call.
        const narrowed = yield* call({ disable: ["*"], enable: ["pr", "feedback", "respond"] })
        expect(narrowed.enabled).toBe(3)
        expect(narrowed.changed).toHaveLength(45)
        expect(narrowed.changed).not.toContain("pr")
        expect(["pr", "feedback", "respond", "toolset", "wait"].map(toolset.enabled)).toEqual([
          true,
          true,
          true,
          true,
          false,
        ])
        expect(reloads).toBe(2)

        // A second load for the same project, as after a restart, sees the same state.
        const again = GitHubToolset.make({ deps, tools: registered, reload: () => Effect.void, project: "project-a" })
        yield* again.load
        expect(again.enabled("feedback")).toBe(true)
        expect(again.enabled("wait")).toBe(false)

        // Listing changes nothing and summarizes only hidden tools.
        const listed = yield* call({ list: "secret*" })
        expect(listed).toEqual({
          enabled: 3,
          hidden: 74,
          sections: [
            {
              name: "secrets",
              aliases: ["admin", "settings", "dependabot", "codespaces"],
              tools: [
                {
                  name: "secrets",
                  enabled: false,
                  summary:
                    "List GitHub secret names (never values) for Actions, Dependabot or Codespaces across scopes.",
                },
                {
                  name: "secret_set",
                  enabled: false,
                  summary:
                    "Set or delete one GitHub secret (Actions, Dependabot, Codespaces) in a repository, environment or organization.",
                },
              ],
            },
          ],
        })
        expect(reloads).toBe(2)

        const reset = yield* call({ reset: true })
        expect(reset.enabled).toBe(44)
        expect(reset.sections).toBeUndefined()
        expect(toolset.enabled("wait")).toBe(true)
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

        yield* run(worktree.toolset, { enable: ["webhooks"] })
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
