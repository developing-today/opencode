import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Service, type Endpoint } from "@opencode/client/effect/service"
import { ServerConnection } from "../../services/server-connection"

const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put"])

// The OpenAPI document is parsed whole, so it cannot be streamed like the
// response body below; bound it instead. The document this CLI is built
// against is well under 1 MiB (packages/protocol/openapi.json), so 16 MiB
// leaves generous headroom while still failing a hostile or broken server
// response instead of buffering it without limit.
export const maxOpenApiBytes = 16 * 1024 * 1024

type Operation = {
  operationId?: string
}

type OpenApi = {
  paths?: Record<string, Record<string, Operation>>
}

const eolBytes = new TextEncoder().encode(EOL)

/**
 * Relay a fetch response body to `write` chunk by chunk as it arrives, so
 * memory use stays independent of the body size: the body is never collected
 * whole (the previous `response.text()` buffered an arbitrary, server-sized
 * body — and hung on an endless one — before a byte reached stdout).
 * The writer may return a promise (e.g. waiting for stdout `drain`); it is
 * awaited before the next chunk is read, so a slow consumer applies
 * backpressure instead of letting an unbounded queue build up in the
 * writable — without that, the buffering would merely move to stdout.
 * Returns the byte count and whether the body ended with the platform EOL,
 * so the caller can preserve the trailing-EOL output behaviour.
 */
export async function streamResponseBody(
  response: Response,
  write: (chunk: Uint8Array) => void | Promise<void>,
): Promise<{ bytes: number; endsWithEol: boolean }> {
  let bytes = 0
  let tail = new Uint8Array(0)
  const note = (chunk: Uint8Array) => {
    bytes += chunk.byteLength
    if (eolBytes.length === 0) return
    const merged = new Uint8Array(tail.byteLength + chunk.byteLength)
    merged.set(tail)
    merged.set(chunk, tail.byteLength)
    tail = merged.slice(Math.max(0, merged.byteLength - eolBytes.length))
  }
  if (!response.body) {
    // No stream to relay (exotic Response implementations only); fall back
    // to a single write of the collected text.
    const text = await response.text()
    if (text) {
      const chunk = new TextEncoder().encode(text)
      await write(chunk)
      note(chunk)
    }
  } else {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      await write(value)
      note(value)
    }
  }
  return {
    bytes,
    endsWithEol: bytes > 0 && tail.byteLength === eolBytes.length && tail.every((byte, index) => byte === eolBytes[index]),
  }
}

/**
 * Bounded body read for the one response this handler must collect whole
 * (the OpenAPI document), in the style of core's `readBoundedResponseText`
 * (packages/core/src/tool/http-body.ts) — the CLI cannot import core, so the
 * seam lives here. A declared `content-length` above the cap fails before
 * the body is read; a chunked body without one is bounded in flight.
 */
export async function readBoundedText(
  response: Response,
  maximumBytes: number,
  tooLarge: () => Error,
): Promise<string> {
  const contentLength = response.headers.get("content-length")
  const parsedSize = contentLength ? Number.parseInt(contentLength, 10) : undefined
  const declaredSize =
    parsedSize !== undefined && Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined
  if (declaredSize !== undefined && declaredSize > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maximumBytes) throw tooLarge()
    return text
  }
  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.byteLength === 0) continue
    if (size + value.byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined)
      throw tooLarge()
    }
    chunks.push(value)
    size += value.byteLength
  }
  const body = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

export default Runtime.handler(
  Commands.commands.api,
  Effect.fn("cli.api")(function* (input) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      mismatch: "ignore",
    })
    const endpoint = server.endpoint
    const params = Option.getOrElse(input.param, () => ({}))
    const request = yield* resolveRequest(endpoint, input.request, params)
    const headers = new Headers(Service.headers(endpoint))
    for (const header of input.header) {
      const index = header.indexOf(":")
      if (index < 1) return yield* Effect.fail(new Error(`Invalid header, expected name:value: ${header}`))
      headers.set(header.slice(0, index).trim(), header.slice(index + 1).trim())
    }
    const body = Option.getOrUndefined(input.data)
    if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")

    const response = yield* Effect.tryPromise(() =>
      fetch(new URL(request.path, endpoint.url), {
        method: request.method,
        headers,
        body,
      }),
    )
    const output = yield* Effect.promise(() =>
      streamResponseBody(response, async (chunk) => {
        // Respect stdout backpressure: when the write buffer is full,
        // wait for it to drain before streamResponseBody reads more.
        if (!process.stdout.write(chunk)) {
          await new Promise<void>((resolve) => process.stdout.once("drain", resolve))
        }
      }),
    )
    if (output.bytes > 0 && !output.endsWithEol) process.stdout.write(EOL)
    if (!response.ok) {
      process.stderr.write(`HTTP ${response.status} ${response.statusText}${EOL}`)
      process.exitCode = 1
    }
  }),
)

export function resolveOperation(spec: OpenApi, operationID: string, params: Record<string, string>) {
  for (const [path, operations] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(operations)) {
      if (!methods.has(method) || operation.operationId !== operationID) continue
      return { method: method.toUpperCase(), path: interpolate(path, params) }
    }
  }
  throw new Error(`Operation not found: ${operationID}`)
}

export function rawRequest(input: readonly string[]) {
  if (input.length !== 2 || !methods.has(input[0].toLowerCase()) || !input[1].startsWith("/")) return
  return { method: input[0].toUpperCase(), path: input[1] }
}

function resolveRequest(endpoint: Endpoint, input: readonly string[], params: Record<string, string>) {
  const raw = rawRequest(input)
  if (raw) return Effect.succeed(raw)
  if (input.length !== 1) return Effect.fail(new Error("Expected an operation name or an HTTP method and path"))
  return Effect.tryPromise(async () => {
    const response = await fetch(new URL("/openapi.json", endpoint.url), { headers: Service.headers(endpoint) })
    if (!response.ok) throw new Error(`Failed to load OpenAPI document: HTTP ${response.status}`)
    const text = await readBoundedText(
      response,
      maxOpenApiBytes,
      () => new Error(`OpenAPI document exceeded ${maxOpenApiBytes} bytes`),
    )
    let spec: OpenApi
    try {
      spec = JSON.parse(text) as OpenApi
    } catch {
      throw new Error("Failed to parse OpenAPI document")
    }
    return resolveOperation(spec, input[0], params)
  })
}

function interpolate(path: string, params: Record<string, string>) {
  const used = new Set<string>()
  const pathname = path.replaceAll(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`Missing path parameter: ${name}`)
    used.add(name)
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams(Object.entries(params).filter(([name]) => !used.has(name))).toString()
  return query ? `${pathname}?${query}` : pathname
}
