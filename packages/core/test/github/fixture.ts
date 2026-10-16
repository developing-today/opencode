import { Agent } from "@opencode/core/agent"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { GitHubClient } from "@opencode/core/tool/plugin/github/client"
import type { GitHubShared } from "@opencode/core/tool/plugin/github/shared"
import { Session as SessionSchema } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { AppProcess } from "@opencode/util/process"
import { Effect, Layer, Schema, Scope } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"

export interface Request {
  readonly method: string
  readonly url: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

export interface Reply {
  readonly status?: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

/** A route answers `METHOD /path` (REST, path without the api.github.com origin) or `GRAPHQL <operation text>`. */
export type Route = (request: Request) => Reply | undefined

/**
 * An in-process GitHub: REST routes are matched by `METHOD /path`, GraphQL by a substring of the query. Unmatched
 * requests answer 599 so a test fails loudly instead of reaching the network.
 */
export function fakeGitHub(routes: Record<string, Reply | Route>) {
  const requests: Request[] = []
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url)
      const raw = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : undefined
      const body = raw === undefined ? undefined : parse(raw)
      const recorded: Request = {
        method: request.method,
        url: request.url,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body,
      }
      requests.push(recorded)
      const graphql = url.pathname === "/graphql" && typeof body === "object" && body !== null && "query" in body
      const reply = graphql
        ? Object.entries(routes)
            .filter(([key]) => key.startsWith("GRAPHQL "))
            .map(([key, route]) => (String((body as { query: string }).query).includes(key.slice(8)) ? answer(route, recorded) : undefined))
            .find((value) => value !== undefined)
        : answer(routes[`${request.method} ${url.pathname}`], recorded)
      const resolved = reply ?? { status: 599, body: { message: `unrouted ${request.method} ${url.pathname}` } }
      const payload = graphql && reply && resolved.status === undefined ? { data: resolved.body } : resolved.body
      return HttpClientResponse.fromWeb(
        request,
        new Response(payload === undefined ? null : JSON.stringify(payload), {
          status: resolved.status ?? 200,
          headers: { "content-type": "application/json", ...resolved.headers },
        }),
      )
    }),
  )
  return { http, requests }
}

function answer(route: Reply | Route | undefined, request: Request) {
  if (route === undefined) return undefined
  return typeof route === "function" ? route(request) : route
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function memoryKV(): KV.Interface {
  const store = new Map<string, Schema.Json>()
  return {
    get: (key) => Effect.sync(() => store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value)),
    remove: (key) => Effect.sync(() => void store.delete(key)),
    scan: (options) =>
      Effect.sync(() => ({
        entries: [...store]
          .filter(([key]) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
          .map(([key, value]) => ({ key, value })),
      })),
  }
}

export const sessionID = SessionSchema.ID.make("ses_github_test")

export const context: Tool.Context = {
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_github_test"),
  id: Tool.CallID.make("call_github_test"),
  progress: () => Effect.void,
}

/** Builds tool dependencies around a fake GitHub. The token comes from GH_TOKEN, so no gh process is spawned. */
export const makeDeps = Effect.fn("test.github.deps")(function* (input: {
  readonly http: HttpClient.HttpClient
  readonly directory?: string
}) {
  const process = yield* AppProcess.Service
  const scope = yield* Scope.Scope
  const kv = memoryKV()
  const asserted: Permission.AssertInput[] = []
  const notified: Parameters<Session.Interface["synthetic"]>[0][] = []
  const jobs = yield* Job.make.pipe(Effect.provideService(Scope.Scope, scope), Effect.provideService(KV.Service, kv))
  const permission = yield* Permission.Service.pipe(
    Effect.provide(Layer.mock(Permission.Service, { assert: (assertion) => Effect.sync(() => void asserted.push(assertion)) })),
  )
  const sessions = yield* Session.Service.pipe(
    Effect.provide(
      Layer.mock(Session.Service, {
        synthetic: (message) =>
          Effect.sync(() => {
            notified.push(message)
          }).pipe(Effect.andThen(Effect.never)),
      }),
    ),
  )
  const deps: GitHubShared.Deps = {
    client: GitHubClient.make({ http: input.http, process }),
    process,
    kv,
    permission,
    sessions,
    jobs,
    scope,
    directory: input.directory ?? "/nonexistent-github-test-directory",
    codemode: true,
  }
  return { deps, kv, asserted, notified }
})

/** Runs a tool's executor and checks its output against the declared schema, as the registry would. */
export const run = <I, O>(tool: Tool.Info, input: I) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(tool.input as Schema.Codec<I, unknown>)(input)
    const result = yield* tool.execute(decoded, context)
    yield* Schema.encodeUnknownEffect(tool.output as Schema.Codec<O, unknown>)(result.output)
    return result.output as O
  })

export const find = (tools: ReadonlyArray<Tool.Info>, name: string) => {
  const tool = tools.find((item) => item.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}
