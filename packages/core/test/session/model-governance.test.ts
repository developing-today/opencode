import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Agent } from "@opencode/core/agent"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { NotFoundError } from "@opencode/core/session"
import { ModelGovernance } from "@opencode/core/session/model-governance"
import { SessionSchema } from "@opencode/core/session/schema"
import { Money } from "@opencode/schema/money"

const decodeInfo = Schema.decodeUnknownSync(Info)

const ref = (input: string) => Model.Ref.parse(input)

const info = (
  id: string,
  options: {
    parentID?: string
    agent?: string
    model?: string
    subagentPolicy?: SessionSchema.SubagentPolicy
  } = {},
): SessionSchema.Info =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make(id),
    parentID: options.parentID ? SessionSchema.ID.make(options.parentID) : undefined,
    projectID: Project.ID.global,
    agent: options.agent ? Agent.ID.make(options.agent) : undefined,
    model: options.model ? ref(options.model) : undefined,
    subagentPolicy: options.subagentPolicy,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
  })

const sessions = (list: SessionSchema.Info[]) => {
  const byID = new Map(list.map((session) => [session.id, session]))
  return {
    get: (sessionID: SessionSchema.ID) => {
      const session = byID.get(sessionID)
      return session ? Effect.succeed(session) : Effect.fail(new NotFoundError({ sessionID }))
    },
  }
}

type Input = Parameters<typeof ModelGovernance.assertAllowed>[2] & {
  all: SessionSchema.Info[]
  configInput?: Record<string, unknown>
}

const entriesConfig = (input: Record<string, unknown> = {}) => ({
  entries: () =>
    Effect.succeed([
      {
        type: "document" as const,
        info: decodeInfo(input),
      } as never,
    ]),
})

const run = (input: Input) =>
  Effect.runPromise(ModelGovernance.assertAllowed(sessions(input.all), entriesConfig(input.configInput ?? {}), input))

const runDenied = async (input: Input) => {
  const error = await Effect.runPromise(
    ModelGovernance.assertAllowed(sessions(input.all), entriesConfig(input.configInput ?? {}), input).pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
  return (error as ModelGovernance.DeniedError).message
}

describe("ModelGovernance.assertAllowed", () => {
  test("composes ancestor policies by intersection (the Haiku example)", async () => {
    const primary = info("ses_primary", {
      subagentPolicy: { models: ["cline-pass/*", "anthropic/claude-haiku-5-5"] },
    })
    const child = info("ses_child", {
      parentID: "ses_primary",
      subagentPolicy: { models: ["anthropic/claude-opus-5-5", "anthropic/claude-haiku-5-5"] },
    })
    const all = [primary, child]

    await run({ all, parent: child, model: ref("anthropic/claude-haiku-5-5") })
    const message = await runDenied({ all, parent: child, model: ref("anthropic/claude-opus-5-5") })
    expect(message).toContain("anthropic/claude-opus-5-5")
    expect(message).toContain("anthropic/claude-haiku-5-5")
    expect(message).not.toContain("cline-pass")
    const pooled = await runDenied({ all, parent: child, model: ref("cline-pass/pool-model") })
    expect(pooled).toContain("anthropic/claude-haiku-5-5")
  })

  test("excluded selectors beat allowed selectors", async () => {
    const parent = info("ses_parent", {
      subagentPolicy: { models: ["anthropic/*"], excludedModels: ["anthropic/claude-opus-5-5"] },
    })
    await run({ all: [parent], parent, model: ref("anthropic/claude-sonnet-5") })
    const message = await runDenied({ all: [parent], parent, model: ref("anthropic/claude-opus-5-5") })
    expect(message).toContain("excluded")
    expect(message).toContain("anthropic/claude-opus-5-5")
  })

  test("a definition whose list holds only its default locks the agent to it", async () => {
    const parent = info("ses_parent")
    const configInput = { agents: { locked: { model: "test/only", models: ["test/only"] } } }
    await run({ all: [parent], parent, configInput, agent: Agent.ID.make("locked") })
    await run({ all: [parent], parent, configInput, agent: Agent.ID.make("locked"), model: ref("test/only") })
    const message = await runDenied({
      all: [parent],
      parent,
      configInput,
      agent: Agent.ID.make("locked"),
      model: ref("test/other"),
    })
    expect(message).toContain("test/only")
  })

  test("the launching agent's subagent lists bind its direct children only", async () => {
    const parent = info("ses_parent", { agent: "reasoner" })
    const child = info("ses_child", { parentID: "ses_parent", agent: "worker" })
    const configInput = { agents: { reasoner: { subagent_models: ["anthropic/claude-haiku-5-5"] } } }
    const all = [parent, child]
    await run({ all, parent, configInput, model: ref("anthropic/claude-haiku-5-5") })
    await runDenied({ all, parent, configInput, model: ref("anthropic/claude-opus-5-5") })
    // The grandchild's launch is governed by its own parent's definition, not Reasoner's.
    await run({ all, parent: child, configInput, model: ref("anthropic/claude-opus-5-5") })
  })

  test("an override without force can narrow but not widen a definition", async () => {
    const parent = info("ses_parent", {
      subagentPolicy: { agentOverrides: { worker: { models: ["test/a", "test/b"] } } },
    })
    const configInput = { agents: { worker: { models: ["test/a"] } } }
    const all = [parent]
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a") })
    await runDenied({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/b") })
  })

  test("an override with force replaces the definition's lists", async () => {
    const parent = info("ses_parent", {
      subagentPolicy: { agentOverrides: { worker: { models: ["test/b"], force: true } } },
    })
    const configInput = { agents: { worker: { models: ["test/a"] } } }
    const all = [parent]
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/b") })
    await runDenied({ all, parent, configInput, agent: Agent.ID.make("worker"), model: ref("test/a") })
  })

  test("a per-call force override replaces definition lists but cannot force past ancestor policy", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/a"] } })
    const configInput = { agents: { worker: { models: ["test/c"] } } }
    const all = [parent]
    // Force clears the definition's list, so the policy-allowed model passes.
    await run({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/a"),
      override: { force: true },
    })
    // But the ancestor policy is hard: even a forced override naming it cannot widen past it.
    const message = await runDenied({
      all,
      parent,
      configInput,
      agent: Agent.ID.make("worker"),
      model: ref("test/b"),
      override: { force: true, models: ["test/b"] },
    })
    // The ancestor policy (test/a only) intersected with the forced list leaves nothing.
    expect(message).toContain("Allowed models: none")
    expect(message).toContain("session policy")
  })

  test("an override model replaces the definition default in the checked chain", async () => {
    const parent = info("ses_parent", { subagentPolicy: { models: ["test/b"] } })
    const configInput = { agents: { worker: { model: "test/a", models: ["test/a", "test/b"] } } }
    const all = [parent]
    // The agent default (test/a) is outside the policy, so the default chain is denied.
    await runDenied({ all, parent, configInput, agent: Agent.ID.make("worker") })
    // Naming test/b explicitly is the override: it replaces the default outright.
    await run({ all, parent, configInput, agent: Agent.ID.make("worker"), override: { model: ref("test/b") } })
  })

  test("a route-named model passes only when every route target passes", async () => {
    const open = info("ses_open")
    const configInput = {
      experimental: { model_routes: { main: { targets: ["test/a", "test/b"] } } },
    }
    const route = ref("opencode-route/main")
    await run({ all: [open], parent: open, configInput, model: route })
    const restricted = info("ses_restricted", { subagentPolicy: { models: ["test/a"] } })
    const message = await runDenied({ all: [restricted], parent: restricted, configInput, model: route })
    expect(message).toContain("test/b")
    expect(message).toContain("route")
  })

  test("an agent default naming a route is judged by all of the route's targets", async () => {
    const configInput = {
      agents: { routed: { model: "opencode-route/main" } },
      experimental: { model_routes: { main: { targets: ["test/a", "test/c"] } } },
    }
    // Every target allowed and none excluded: the route default passes.
    const open = info("ses_open", {
      subagentPolicy: { models: ["test/*"], excludedModels: ["test/b"] },
    })
    await run({ all: [open], parent: open, configInput, agent: Agent.ID.make("routed") })
    // One target excluded: the same default fails, naming that target.
    const excluding = info("ses_excluding", {
      subagentPolicy: { models: ["test/*"], excludedModels: ["test/c"] },
    })
    const message = await runDenied({
      all: [excluding],
      parent: excluding,
      configInput,
      agent: Agent.ID.make("routed"),
    })
    expect(message).toContain("test/c")
    expect(message).toContain("route")
    // One target outside the allowed set also fails the route.
    const narrowing = info("ses_narrowing", { subagentPolicy: { models: ["test/a"] } })
    const narrowed = await runDenied({
      all: [narrowing],
      parent: narrowing,
      configInput,
      agent: Agent.ID.make("routed"),
    })
    expect(narrowed).toContain("test/c")
  })

  test("with no explicit choice the inherited parent model is what gets checked", async () => {
    const parent = info("ses_parent", { model: "test/parent", subagentPolicy: { models: ["test/parent"] } })
    await run({ all: [parent], parent })
    const restricted = info("ses_restricted", {
      model: "test/parent",
      subagentPolicy: { models: ["test/other"] },
    })
    const message = await runDenied({ all: [restricted], parent: restricted })
    expect(message).toContain("test/parent")
  })

  test("an unrestricted launch passes any model", async () => {
    const parent = info("ses_parent")
    await run({ all: [parent], parent, model: ref("anything/at-all") })
  })

  test("a missing ancestor fails instead of silently passing", async () => {
    const child = info("ses_child", { parentID: "ses_gone" })
    const message = await runDenied({ all: [child], parent: child, model: ref("test/a") })
    expect(message).toContain("Parent session not found: ses_gone")
  })
})
