import { describe, expect, test } from "bun:test"
import { EOL } from "node:os"
import { rawRequest, readBoundedText, resolveOperation, streamResponseBody } from "./api"

describe("api request resolution", () => {
  test("resolves an operation ID with path and query parameters", () => {
    expect(
      resolveOperation(
        {
          paths: {
            "/api/session/{sessionID}": {
              get: { operationId: "session.get" },
            },
          },
        },
        "session.get",
        { sessionID: "ses/a", workspace: "work" },
      ),
    ).toEqual({ method: "GET", path: "/api/session/ses%2Fa?workspace=work" })
  })

  test("rejects a missing path parameter", () => {
    expect(() =>
      resolveOperation(
        { paths: { "/api/session/{sessionID}": { get: { operationId: "session.get" } } } },
        "session.get",
        {},
      ),
    ).toThrow("Missing path parameter: sessionID")
  })

  test("resolves curl-like method and path input", () => {
    expect(rawRequest(["post", "/api/foo"])).toEqual({ method: "POST", path: "/api/foo" })
    expect(rawRequest(["session.list"])).toBeUndefined()
  })
})

describe("api response body handling", () => {
  const chunked = (chunks: Array<Uint8Array>) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk)
          controller.close()
        },
      }),
    )

  test("streams a large chunked body in pieces instead of one whole write", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97)
    const writes: Array<Uint8Array> = []
    const result = await streamResponseBody(chunked(Array.from({ length: 100 }, () => chunk)), (value) => {
      writes.push(value)
    })
    expect(result.bytes).toBe(100 * chunk.byteLength)
    expect(writes.length).toBe(100)
    expect(writes.every((value) => value.byteLength === chunk.byteLength)).toBe(true)
    expect(result.endsWithEol).toBe(false)
  })

  test("reports a trailing EOL and writes nothing for an empty body", async () => {
    const writes: Array<Uint8Array> = []
    const result = await streamResponseBody(chunked([new TextEncoder().encode("hello" + EOL)]), (value) => {
      writes.push(value)
    })
    expect(result.endsWithEol).toBe(true)
    expect(new TextDecoder().decode(writes[0])).toBe("hello" + EOL)

    const empty = await streamResponseBody(chunked([]), () => {
      throw new Error("empty body must not be written")
    })
    expect(empty).toEqual({ bytes: 0, endsWithEol: false })
  })

  test("awaits an asynchronous writer before reading more chunks (backpressure)", async () => {
    let active = 0
    let maxActive = 0
    let writes = 0
    const chunks = Array.from({ length: 10 }, (_, index) => new TextEncoder().encode(`chunk-${index};`))
    const result = await streamResponseBody(chunked(chunks), async () => {
      active++
      maxActive = Math.max(maxActive, active)
      writes++
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
    })
    expect(result.bytes).toBe(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    expect(writes).toBe(chunks.length)
    // If writes were not awaited, all 10 would be in flight at once and the
    // body would queue unboundedly behind a slow consumer.
    expect(maxActive).toBe(1)
  })

  test("cancels the response read when the writer fails", async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("chunk;"))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    await expect(
      streamResponseBody(response, () => {
        throw new Error("output gone")
      }),
    ).rejects.toThrow("output gone")
    expect(cancelled).toBe(true)
  })

  test("readBoundedText returns a body under the cap and rejects one over it", async () => {
    await expect(readBoundedText(new Response("ok"), 1024, () => new Error("too large"))).resolves.toBe("ok")
    const chunk = new Uint8Array(512).fill(98)
    await expect(
      readBoundedText(chunked([chunk, chunk, chunk]), 1024, () => new Error("too large")),
    ).rejects.toThrow("too large")
    await expect(
      readBoundedText(new Response("ok", { headers: { "content-length": "2048" } }), 1024, () => new Error("too large")),
    ).rejects.toThrow("too large")
  })
})
