import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionStore } from "@opencode/core/session/store"
import { ModelGovernance } from "@opencode/core/session/model-governance"
import { EventTable } from "@opencode/core/event/sql"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = (id: string) => Model.Ref.make({ id: Model.ID.make(id), providerID: Provider.ID.make("test") })

describe("Session model governance", () => {
  it.effect("stores the policy given at create and denies a forbidden child, creating nothing", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        subagentPolicy: { models: ["test/allowed"] },
      })
      expect(parent.subagentPolicy).toEqual({ models: ["test/allowed"] })

      const error = yield* session
        .create({ parentID: parent.id, agent: Agent.ID.make("worker"), model: model("denied") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((error as ModelGovernance.DeniedError).message).toContain("test/allowed")
      expect((yield* session.list()).data).toEqual([parent])

      const child = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("worker"),
        model: model("allowed"),
      })
      expect(child.parentID).toBe(parent.id)
      expect((yield* session.list()).data).toHaveLength(2)
    }),
  )

  it.effect("setSubagentPolicy applies live to later launches without a restart", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, model: model("kept") })

      const before = yield* session.create({ parentID: parent.id, model: model("kept") })
      expect(before.model?.id).toBe(Model.ID.make("kept"))

      yield* session.setSubagentPolicy({ sessionID: parent.id, subagentPolicy: { models: ["test/other"] } })
      expect((yield* session.get(parent.id)).subagentPolicy).toEqual({ models: ["test/other"] })
      expect(
        yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, parent.id))
          .all()
          .pipe(Effect.orDie),
      ).toContainEqual({ type: Bus.versionedType(SessionEvent.SubagentPolicyUpdated.type, 1) })

      const error = yield* session.create({ parentID: parent.id, model: model("kept") }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      const allowed = yield* session.create({ parentID: parent.id, model: model("other") })
      expect(allowed.model?.id).toBe(Model.ID.make("other"))

      expect(
        yield* session
          .setSubagentPolicy({ sessionID: Session.ID.create(), subagentPolicy: {} })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Session.NotFoundError)
    }),
  )

  it.effect("a tightened policy binds a running child's later switchModel, but not a top-level session's", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        model: model("a"),
        subagentPolicy: { models: ["test/a", "test/b"] },
      })
      const child = yield* session.create({ parentID: parent.id, model: model("a") })

      yield* session.switchModel({ sessionID: child.id, model: model("b") })
      expect((yield* session.get(child.id)).model?.id).toBe(Model.ID.make("b"))

      yield* session.setSubagentPolicy({ sessionID: parent.id, subagentPolicy: { models: ["test/a"] } })
      yield* session.switchModel({ sessionID: child.id, model: model("a") })
      const error = yield* session.switchModel({ sessionID: child.id, model: model("b") }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((yield* session.get(child.id)).model?.id).toBe(Model.ID.make("a"))

      // Top-level sessions are unchecked.
      yield* session.switchModel({ sessionID: parent.id, model: model("b") })
      expect((yield* session.get(parent.id)).model?.id).toBe(Model.ID.make("b"))
    }),
  )

  it.effect("a tightened policy binds a child's switchAgent, but not a top-level session's", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        model: model("a"),
        subagentPolicy: { models: ["test/a", "test/b"] },
      })
      const child = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("worker"),
        model: model("b"),
      })

      // Permitted while the child's model is inside the policy.
      yield* session.switchAgent({ sessionID: child.id, agent: Agent.ID.make("reviewer") })
      expect((yield* session.get(child.id)).agent).toBe(Agent.ID.make("reviewer"))

      yield* session.setSubagentPolicy({ sessionID: parent.id, subagentPolicy: { models: ["test/a"] } })
      const error = yield* session
        .switchAgent({ sessionID: child.id, agent: Agent.ID.make("specialist") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((error as ModelGovernance.DeniedError).message).toContain("test/a")
      // A denied switch publishes nothing: the child keeps its agent and model.
      const after = yield* session.get(child.id)
      expect(after.agent).toBe(Agent.ID.make("reviewer"))
      expect(after.model?.id).toBe(Model.ID.make("b"))

      // Top-level sessions are unchecked.
      yield* session.switchAgent({ sessionID: parent.id, agent: Agent.ID.make("specialist") })
      expect((yield* session.get(parent.id)).agent).toBe(Agent.ID.make("specialist"))
    }),
  )

  it.effect("forking a session whose model is outside its own subsession policy fails", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({
        location,
        model: model("opus"),
        subagentPolicy: { models: ["test/haiku"] },
      })
      yield* session.prompt({ sessionID: parent.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")

      const error = yield* session.fork({ sessionID: parent.id }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      expect((error as ModelGovernance.DeniedError).message).toContain("test/haiku")
    }),
  )

  it.effect("a permitted fork copies the source session's subagent policy", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({
        location,
        model: model("haiku"),
        subagentPolicy: { models: ["test/haiku"], excludedModels: ["test/opus"] },
      })
      yield* session.prompt({ sessionID: parent.id, text: "Fork context", resume: false })
      yield* SessionInbox.promote(db, bus, parent.id, "steer")

      const forked = yield* session.fork({ sessionID: parent.id })
      expect(forked.subagentPolicy).toEqual({ models: ["test/haiku"], excludedModels: ["test/opus"] })
      expect(forked.model?.id).toBe(Model.ID.make("haiku"))
    }),
  )

  it.effect("a policy agent override narrows the models a named agent may launch with", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const parent = yield* session.create({
        location,
        subagentPolicy: {
          models: ["test/*"],
          agentOverrides: { worker: { models: ["test/a"] } },
        },
      })
      const error = yield* session
        .create({ parentID: parent.id, agent: Agent.ID.make("worker"), model: model("b") })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(ModelGovernance.DeniedError)
      const child = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("worker"),
        model: model("a"),
      })
      expect(child.model?.id).toBe(Model.ID.make("a"))
      // Other agents are bound only by the policy's own list.
      const other = yield* session.create({
        parentID: parent.id,
        agent: Agent.ID.make("other"),
        model: model("b"),
      })
      expect(other.model?.id).toBe(Model.ID.make("b"))
    }),
  )
})
