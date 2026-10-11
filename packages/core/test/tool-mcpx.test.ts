import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeLocationNode, makeGlobalNode } from "@opencode/util/effect/app-node"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Environment } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Location } from "@opencode/core/location"
import { FileAccess } from "@opencode/core/file-access"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStore } from "@opencode/core/session/store"
import { Permission } from "@opencode/core/permission"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"
import { Tool } from "@opencode/core/tool"
import { Plugin } from "@opencode/core/plugin"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, toolIdentity, registerToolPlugin } from "./lib/tool"

const sessionID = Session.ID.make("ses_mcpx_tool_test")
const sessionModel = Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("test") })

const permission = permissionLayer({ assert: () => Effect.void })

// The tool hooks the mcpx plugin registers, so tests can play the part of the tool host
const toolHooks = new Map<string, (event: any) => Effect.Effect<void>>()

const mcpxPluginSupervisor = makeLocationNode({
  name: "test/mcpx-plugins",
  layer: Layer.effectDiscard(
    registerToolPlugin(
      McpxTool.Plugin,
      {
        shell: {
          hook: () => Effect.succeed({ dispose: Effect.void }),
        },
      },
      (name: string, callback: unknown) => {
        toolHooks.set(name, callback as (event: any) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    ),
  ),
  deps: [Config.node, Environment.node, FileAccess.node, Permission.node, Tool.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  LocationServiceMap.node,
  filesystem,
  FSUtil.node,
  Global.node,
])

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.succeed(
    SessionExecution.Service,
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const it = testEffect(
  AppNodeBuilder.build(nodes, [
    SessionExecution.node.replace(executionNode),
    Permission.node.replace(permission),
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    PluginSupervisor.node.replace(mcpxPluginSupervisor),
  ]),
)

const withSession = <A, E, R>(directory: string, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory) })
    yield* sessions.create({ id: sessionID, title: "mcpx test", location, model: sessionModel })
    const locations = yield* LocationServiceMap.Service
    const locationLayer = locations.get(location)
    return yield* Effect.gen(function* () {
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(toolIdentity.agent, (agent) => {
          agent.permissions = []
        }),
      )
      const plugins = yield* Plugin.Service
      yield* plugins.awaitActivation
      const registry = yield* Tool.Service
      return yield* body(registry)
    }).pipe(Effect.provide(locationLayer), Effect.ensuring(locations.invalidate(location)))
  })

describe("McpxTool", () => {
  it.live("registers mcpx_exec, mcpx_discover, and mcpx_observe tools", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      yield* withSession(tmp.path, (registry) =>
        Effect.gen(function* () {
          const tools = yield* registry.list()
          const names = tools.map((t) => t.name)
          expect(names).toContain("mcpx_exec")
          expect(names).toContain("mcpx_discover")
          expect(names).toContain("mcpx_observe")
          expect(names).toContain("mcpx_project")
          expect(names).toContain("mcpx_retract")
        }),
      )
    }),
  )

  it.live("projects daemon tools into the registry, calls them, and retracts them", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const requests: Array<{ path: string; body?: any }> = []
      const daemon = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const path = new URL(request.url).pathname
          const body = request.method === "POST" ? await request.json().catch(() => undefined) : undefined
          requests.push({ path, body })
          if (path === "/v1/tools") return Response.json(neonTools)
          if (path === "/v1/call") return Response.json({ result: { rows: 2 } })
          return Response.json({ status: "ok" })
        },
      })
      const previous = process.env.MCPX_DAEMON_ENDPOINT
      process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${daemon.port}`
      try {
        yield* withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const names = () => registry.list().pipe(Effect.map((tools) => tools.map((tool) => tool.name)))
            expect(yield* names()).not.toContain("neon_run_sql")

            const projected = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-project", name: "mcpx_project", input: { namespaces: ["neon"] } },
            })
            expect(projected.status).toBe("completed")
            expect(yield* names()).toContain("neon_run_sql")

            const called = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-neon", name: "neon_run_sql", input: { query: "select 1" } },
            })
            expect(called.status).toBe("completed")
            expect(requests.find((request) => request.path === "/v1/call")?.body).toMatchObject({
              server: "neon",
              tool: "run_sql",
              arguments: { query: "select 1" },
            })

            const retracted = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-retract", name: "mcpx_retract", input: { targets: ["neon"] } },
            })
            expect(retracted.status).toBe("completed")
            expect(yield* names()).not.toContain("neon_run_sql")
          }),
        )
      } finally {
        daemon.stop(true)
        if (previous === undefined) delete process.env.MCPX_DAEMON_ENDPOINT
        else process.env.MCPX_DAEMON_ENDPOINT = previous
      }
    }),
  )

  it.live("steps projection TTL once per assistant message and gives typo hints", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => tmpdir())
      const daemon = Bun.serve({
        port: 0,
        fetch: (request) =>
          new URL(request.url).pathname === "/v1/tools" ? Response.json(neonTools) : Response.json({ status: "ok" }),
      })
      const previous = process.env.MCPX_DAEMON_ENDPOINT
      process.env.MCPX_DAEMON_ENDPOINT = `http://127.0.0.1:${daemon.port}`
      try {
        yield* withSession(tmp.path, (registry) =>
          Effect.gen(function* () {
            const names = () => registry.list().pipe(Effect.map((tools) => tools.map((tool) => tool.name)))
            const project = (id: string) =>
              executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id, name: "mcpx_project", input: { namespaces: ["neon"], ttl: 2 } },
              })
            yield* project("call-project-ttl")
            expect(yield* names()).toContain("neon_run_sql")

            const beforeTool = toolHooks.get("execute.before")
            const afterTool = toolHooks.get("execute.after")
            expect(beforeTool).toBeDefined()
            expect(afterTool).toBeDefined()
            if (!beforeTool || !afterTool) return

            // Two tool calls in one assistant message are one turn; the next message is the second turn
            yield* beforeTool({ messageID: "msg_turn_one" } as any)
            yield* beforeTool({ messageID: "msg_turn_one" } as any)
            expect(yield* names()).toContain("neon_run_sql")
            yield* beforeTool({ messageID: "msg_turn_two" } as any)
            expect(yield* names()).not.toContain("neon_run_sql")

            // A failed call to a misspelled projected tool gets a typo hint with the real name
            yield* project("call-project-typo")
            const failure = {
              tool: "neon_run_sq",
              sessionID,
              agent: toolIdentity.agent,
              messageID: toolIdentity.messageID,
              id: "call-typo",
              input: { query: "select 1" },
              status: "error",
              error: { message: "Unknown tool" },
            }
            yield* afterTool(failure as any)
            expect(failure.error.message).toContain("Typo Detected")
            expect(failure.error.message).toContain("neon_run_sql")

            yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-retract-typo", name: "mcpx_retract", input: { targets: ["neon"] } },
            })
          }),
        )
      } finally {
        daemon.stop(true)
        if (previous === undefined) delete process.env.MCPX_DAEMON_ENDPOINT
        else process.env.MCPX_DAEMON_ENDPOINT = previous
      }
    }),
  )
})

const neonTools = [
  {
    namespace: "neon",
    tool: "run_sql",
    description: "Run SQL",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
]
