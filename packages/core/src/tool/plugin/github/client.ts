export * as GitHubClient from "./client.js"

import { AppProcess } from "@opencode/util/process"
import { Duration, Effect, Option, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http"
import { ChildProcess } from "effect/process"

export const Kind = Schema.Literals([
  "auth",
  "forbidden",
  "not_found",
  "rate_limited",
  "validation",
  "conflict",
  "network",
  "server",
  "unsupported",
])
export type Kind = typeof Kind.Type

export class Error extends Schema.TaggedError<Error>()("GitHub.Error", {
  message: Schema.String,
  kind: Kind,
  status: Schema.optional(Schema.Number),
  hint: Schema.optional(Schema.String),
}) {}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
export type Query = Readonly<Record<string, string | number | boolean | undefined>>

export interface Response<A> {
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly data: A
}

export interface RequestOptions {
  readonly query?: Query
  readonly body?: unknown
  readonly accept?: string
  /** Statuses that are returned instead of failing, such as 404 for optional resources. */
  readonly allow?: ReadonlyArray<number>
}

export interface PaginateOptions {
  readonly query?: Query
  /** Stop after this many items. */
  readonly limit?: number
  /** Property holding the array when the endpoint wraps it, such as `workflow_runs`. */
  readonly key?: string
}

export interface Download {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly truncated: boolean
}

/** One GitHub host's API. Every call authenticates with the same lazily resolved token. */
export interface Api {
  readonly host: string
  readonly web: string
  readonly request: <A = unknown>(
    method: Method,
    path: string,
    options?: RequestOptions,
  ) => Effect.Effect<Response<A>, Error>
  readonly json: <A = unknown>(method: Method, path: string, options?: RequestOptions) => Effect.Effect<A, Error>
  readonly paginate: <A = unknown>(path: string, options?: PaginateOptions) => Effect.Effect<A[], Error>
  readonly graphql: <A = unknown>(query: string, variables?: Record<string, unknown>) => Effect.Effect<A, Error>
  readonly download: (
    path: string,
    options?: {
      readonly accept?: string
      readonly maxBytes?: number
      /** tail keeps the last maxBytes (logs); all fails once the body passes maxBytes (files). Default all. */
      readonly keep?: "tail" | "all"
    },
  ) => Effect.Effect<Download, Error>
  readonly upload: (input: {
    readonly url: string
    readonly bytes: Uint8Array
    readonly contentType: string
    readonly scheme?: "token" | "Bearer"
  }) => Effect.Effect<unknown, Error>
  readonly uploads: string | undefined
  readonly token: Effect.Effect<{ readonly value: string; readonly source: string }, Error>
}

export interface Client {
  readonly forHost: (host: string) => Api
}

const API_VERSION = "2022-11-28"
const USER_AGENT = "opencode-github-tools"
const DEFAULT_DOWNLOAD_BYTES = 20 * 1024 * 1024

export function make(input: { readonly http: HttpClient.HttpClient; readonly process: AppProcess.Interface }): Client {
  const tokens = new Map<string, { value: string; source: string }>()
  const apis = new Map<string, Api>()

  const resolveToken = Effect.fn("GitHubClient.token")(function* (host: string) {
    const cached = tokens.get(host)
    if (cached) return cached
    const fromEnv = envToken(host)
    if (fromEnv) {
      tokens.set(host, fromEnv)
      return fromEnv
    }
    const result = yield* input.process
      .run(ChildProcess.make("gh", ["auth", "token", "--hostname", host], { extendEnv: true, stdin: "ignore" }), {
        timeout: "15 seconds",
      })
      .pipe(
        Effect.flatMap(AppProcess.requireSuccess),
        Effect.mapError(
          (error) =>
            new Error({
              kind: "auth",
              message: `No GitHub credentials for ${host}: ${error.message}`,
              hint: authHint(host),
            }),
        ),
      )
    const value = result.stdout.toString("utf8").trim()
    if (!value)
      return yield* new Error({ kind: "auth", message: `gh returned no token for ${host}`, hint: authHint(host) })
    const token = { value, source: "gh auth token" }
    tokens.set(host, token)
    return token
  })

  const forHost = (host: string): Api => {
    const existing = apis.get(host)
    if (existing) return existing
    const urls = endpoints(host)

    const send = (request: HttpClientRequest.HttpClientRequest, scheme: "token" | "Bearer" = "Bearer") =>
      resolveToken(host).pipe(
        Effect.flatMap((token) =>
          input.http.execute(
            request.pipe(
              HttpClientRequest.setHeaders({
                Authorization: `${scheme} ${token.value}`,
                "X-GitHub-Api-Version": API_VERSION,
                "User-Agent": USER_AGENT,
              }),
            ),
          ),
        ),
        Effect.mapError((error) =>
          error instanceof Error
            ? error
            : new Error({
                kind: "network",
                message: `Unable to reach ${host}: ${error.message}`,
                hint: networkHint(host),
              }),
        ),
      )

    const build = (method: Method, path: string, options: RequestOptions = {}) => {
      const url =
        path.startsWith("https://") || path.startsWith("http://")
          ? path
          : `${urls.api}${path.startsWith("/") ? "" : "/"}${path}`
      const base = HttpClientRequest.make(method)(url, {
        urlParams: Object.fromEntries(
          Object.entries(options.query ?? {}).flatMap(([key, value]) =>
            value === undefined ? [] : [[key, String(value)]],
          ),
        ),
        headers: { Accept: options.accept ?? "application/vnd.github+json" },
      })
      if (options.body === undefined) return base
      return HttpClientRequest.bodyText(base, JSON.stringify(options.body), "application/json")
    }

    // 401 drops the cached token and retries once so a fresh `gh auth login` takes effect without a restart.
    const exchange = (
      method: Method,
      path: string,
      options: RequestOptions = {},
      retried = false,
    ): Effect.Effect<Response<unknown>, Error> =>
      Effect.gen(function* () {
        const response = yield* send(build(method, path, options))
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        const data = parseJson(text)
        const headers = response.headers
        if (response.status === 401 && !retried) {
          tokens.delete(host)
          return yield* exchange(method, path, options, true)
        }
        if (response.status < 400 || options.allow?.includes(response.status))
          return { status: response.status, headers, data }
        return yield* statusError({ host, status: response.status, headers, data, method, path })
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis", 2),
          times: method === "GET" ? 2 : 0,
          while: (error) => error.kind === "server" || error.kind === "network",
        }),
      )

    const api: Api = {
      host,
      web: urls.web,
      uploads: urls.uploads,
      token: resolveToken(host),
      request: <A>(method: Method, path: string, options?: RequestOptions) =>
        exchange(method, path, options).pipe(Effect.map((response) => response as Response<A>)),
      json: <A>(method: Method, path: string, options?: RequestOptions) =>
        exchange(method, path, options).pipe(Effect.map((response) => response.data as A)),
      paginate: <A>(path: string, options: PaginateOptions = {}) =>
        Effect.gen(function* () {
          const limit = options.limit ?? Number.POSITIVE_INFINITY
          const items: A[] = []
          let next: string | undefined = path
          let query: Query | undefined = {
            per_page: Math.min(100, Math.max(1, Number.isFinite(limit) ? limit : 100)),
            ...options.query,
          }
          while (next && items.length < limit) {
            const response: Response<unknown> = yield* exchange("GET", next, { query })
            const page = options.key
              ? (response.data as Record<string, unknown> | undefined)?.[options.key]
              : response.data
            if (!Array.isArray(page)) break
            items.push(...(page as A[]))
            next = nextLink(response.headers.link)
            // The next link already carries the query string.
            query = undefined
          }
          return items.slice(0, limit)
        }),
      graphql: <A>(query: string, variables: Record<string, unknown> = {}) =>
        exchange("POST", urls.graphql, { body: { query, variables } }).pipe(
          Effect.flatMap((response) => {
            const body = response.data as { data?: A; errors?: ReadonlyArray<GraphQLError> } | undefined
            if (body?.errors?.length) return Effect.fail(graphqlError(host, body.errors))
            if (body?.data === undefined)
              return Effect.fail(new Error({ kind: "server", message: "GitHub GraphQL returned no data" }))
            return Effect.succeed(body.data)
          }),
        ),
      download: (path, options = {}) =>
        Effect.gen(function* () {
          const first = yield* send(
            build("GET", path, { accept: options.accept ?? "application/vnd.github+json" }),
          ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))
          const location = first.headers.location
          // Signed redirect targets reject GitHub credentials, so the follow-up request carries none.
          const response =
            first.status >= 300 && first.status < 400 && location
              ? yield* input.http
                  .execute(HttpClientRequest.get(location))
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new Error({ kind: "network", message: `Unable to download ${path}: ${error.message}` }),
                    ),
                  )
              : first
          if (response.status >= 400) {
            const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
            return yield* statusError({
              host,
              status: response.status,
              headers: response.headers,
              data: parseJson(text),
              method: "GET",
              path,
            })
          }
          return yield* collect(response, options.maxBytes ?? DEFAULT_DOWNLOAD_BYTES, options.keep ?? "all")
        }),
      upload: (upload) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.post(upload.url, {
            headers: { Accept: "application/vnd.github+json" },
          }).pipe((request) => HttpClientRequest.bodyUint8Array(request, upload.bytes, upload.contentType))
          const response = yield* send(request, upload.scheme ?? "Bearer")
          const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
          const data = parseJson(text)
          if (response.status >= 400)
            return yield* statusError({
              host,
              status: response.status,
              headers: response.headers,
              data,
              method: "POST",
              path: upload.url,
            })
          return data
        }),
    }
    apis.set(host, api)
    return api
  }

  return { forHost }
}

export function endpoints(host: string) {
  if (host === "github.com")
    return {
      web: "https://github.com",
      api: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
      uploads: "https://uploads.github.com" as string | undefined,
    }
  if (host.endsWith(".ghe.com"))
    return {
      web: `https://${host}`,
      api: `https://api.${host}`,
      graphql: `https://api.${host}/graphql`,
      uploads: `https://uploads.${host}` as string | undefined,
    }
  return {
    web: `https://${host}`,
    api: `https://${host}/api/v3`,
    graphql: `https://${host}/api/graphql`,
    uploads: undefined as string | undefined,
  }
}

function envToken(host: string) {
  const cloud = host === "github.com" || host.endsWith(".ghe.com")
  const names = cloud ? ["GH_TOKEN", "GITHUB_TOKEN"] : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
  const name = names.find((name) => process.env[name])
  if (!name) return undefined
  return { value: process.env[name] as string, source: `$${name}` }
}

export function nextLink(header: string | undefined) {
  return link(header, "next")
}

export function link(header: string | undefined, rel: string) {
  return header
    ?.split(",")
    .map((part) => /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim()))
    .find((match) => match?.[2] === rel)?.[1]
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

// Error pages and log downloads are not JSON; keep their text so error messages can quote it.
function parseJson(text: string): unknown {
  if (!text) return undefined
  return Option.getOrElse(decodeJson(text), () => text)
}

interface GraphQLError {
  readonly type?: string
  readonly message: string
  readonly path?: ReadonlyArray<string | number>
}

function graphqlError(host: string, errors: ReadonlyArray<GraphQLError>) {
  const message = errors.map((error) => error.message).join("; ")
  const type = errors[0]?.type
  if (type === "NOT_FOUND") return new Error({ kind: "not_found", message, hint: notFoundHint })
  if (type === "FORBIDDEN" || /not accessible|permission|must have/i.test(message))
    return new Error({ kind: "forbidden", message, hint: forbiddenHint(host, {}) })
  if (type === "RATE_LIMITED")
    return new Error({ kind: "rate_limited", message, hint: "Wait for the GraphQL rate limit to reset, then retry." })
  return new Error({ kind: "validation", message })
}

function statusError(input: {
  readonly host: string
  readonly status: number
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly data: unknown
  readonly method: string
  readonly path: string
}) {
  const body = typeof input.data === "object" && input.data !== null ? (input.data as Record<string, unknown>) : {}
  const details = Array.isArray(body.errors)
    ? body.errors
        .map((item) =>
          typeof item === "string"
            ? item
            : typeof item === "object" && item && "message" in item
              ? String(item.message)
              : JSON.stringify(item),
        )
        .join("; ")
    : ""
  const base =
    typeof body.message === "string" ? body.message : typeof input.data === "string" ? input.data.slice(0, 300) : ""
  const message = `${input.method} ${input.path.replace(/^https:\/\/[^/]+/, "")} failed (${input.status})${base ? `: ${base}` : ""}${details ? ` — ${details}` : ""}`
  const remaining = input.headers["x-ratelimit-remaining"]
  if (input.status === 429 || (input.status === 403 && (remaining === "0" || /rate limit/i.test(base)))) {
    const reset = Number(input.headers["x-ratelimit-reset"])
    const retry = Number(input.headers["retry-after"])
    const when =
      Number.isFinite(retry) && retry > 0
        ? `in ${retry}s`
        : Number.isFinite(reset) && reset > 0
          ? `at ${new Date(reset * 1000).toISOString()}`
          : "shortly"
    return new Error({
      kind: "rate_limited",
      status: input.status,
      message,
      hint: `GitHub rate limit reached; it resets ${when}. Batch work or wait before retrying.`,
    })
  }
  if (input.status === 401) return new Error({ kind: "auth", status: 401, message, hint: authHint(input.host) })
  if (input.status === 403)
    return new Error({ kind: "forbidden", status: 403, message, hint: forbiddenHint(input.host, input.headers) })
  if (input.status === 404) return new Error({ kind: "not_found", status: 404, message, hint: notFoundHint })
  if (input.status === 409) return new Error({ kind: "conflict", status: 409, message })
  if (input.status === 422) return new Error({ kind: "validation", status: 422, message })
  if (input.status >= 500)
    return new Error({
      kind: "server",
      status: input.status,
      message,
      hint: "GitHub returned a server error; retry shortly.",
    })
  return new Error({ kind: "validation", status: input.status, message })
}

const notFoundHint =
  "GitHub answers 404 both for missing resources and for private resources the token cannot see. Check the owner/repo and number, and that the account in `gh auth status` has access."

function authHint(host: string) {
  return `Authenticate with \`gh auth login --hostname ${host}\` (or refresh scopes with \`gh auth refresh --hostname ${host} --scopes repo,read:org,workflow\`), or set GH_TOKEN. Check with \`gh auth status\`.`
}

function networkHint(host: string) {
  return `Check network access to ${host} and any proxy settings, then retry.`
}

function forbiddenHint(host: string, headers: Readonly<Record<string, string | undefined>>) {
  const accepted = headers["x-accepted-github-permissions"] ?? headers["x-accepted-oauth-scopes"]
  const granted = headers["x-oauth-scopes"]
  return [
    "The authenticated account lacks permission for this operation.",
    accepted ? `GitHub accepts: ${accepted}.` : undefined,
    granted !== undefined ? `Token scopes: ${granted || "none"}.` : undefined,
    `Add scopes with \`gh auth refresh --hostname ${host} --scopes <scope>\`, or ask a repository admin.`,
  ]
    .filter(Boolean)
    .join(" ")
}

// Streams the body so a large log or asset never sits in memory whole: a tail keeps a sliding window of the last
// maxBytes, and a full download stops as soon as it passes the limit.
function collect(response: HttpClientResponse.HttpClientResponse, maxBytes: number, keep: "tail" | "all") {
  const contentType = response.headers["content-type"] ?? "application/octet-stream"
  const declared = Number(response.headers["content-length"])
  const tooLarge = (size: number) =>
    new Error({
      kind: "validation",
      message: `Download is ${size} bytes, over the ${maxBytes}-byte limit.`,
      hint: "Use the gh CLI for very large files (see the github skill).",
    })
  if (keep === "all" && Number.isFinite(declared) && declared > maxBytes) return Effect.fail(tooLarge(declared))
  const chunks: Uint8Array[] = []
  let size = 0
  let dropped = false
  return Stream.runForEach(response.stream, (chunk) => {
    chunks.push(chunk)
    size += chunk.byteLength
    if (keep === "all") return size > maxBytes ? Effect.fail(tooLarge(size)) : Effect.void
    while (chunks.length > 1 && size - chunks[0].byteLength >= maxBytes) {
      size -= chunks.shift()?.byteLength ?? 0
      dropped = true
    }
    return Effect.void
  }).pipe(
    Effect.timeout(Duration.minutes(5)),
    Effect.mapError((error) =>
      error instanceof Error ? error : new Error({ kind: "network", message: `Download failed: ${error.message}` }),
    ),
    Effect.map(() => {
      const joined = Buffer.concat(chunks)
      const truncated = dropped || joined.byteLength > maxBytes
      return {
        bytes: new Uint8Array(truncated ? joined.subarray(joined.byteLength - maxBytes) : joined),
        contentType,
        truncated,
      }
    }),
  )
}
