import { describe, expect, test } from "bun:test"
import { CodeModeWeb } from "@opencode/core/codemode/web"

type WebResponse = {
  readonly status: number
  readonly headers: {
    get: (name: string) => string | null
    has: (name: string) => boolean
    entries: () => Array<[string, string]>
  }
}

const webFetch = CodeModeWeb.extension.globals.fetch as (input: string) => Promise<WebResponse>

const serve = (headers: Record<string, string>) => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("hello", { headers }) })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

describe("CodeModeWeb fetch response headers (#805)", () => {
  test("absent prototype-named headers read as null / false, not inherited members", async () => {
    const server = serve({ "content-type": "text/plain", "x-real": "yes" })
    try {
      const response = await webFetch(server.url)
      expect(response.status).toBe(200)
      // Regression: the headers record is a plain object, so a bare index / `in`
      // resolved "constructor" to the Object function and "__proto__" to
      // Object.prototype even though the server never sent them.
      expect(response.headers.get("constructor")).toBeNull()
      expect(response.headers.has("constructor")).toBe(false)
      expect(response.headers.get("__proto__")).toBeNull()
      expect(response.headers.has("__proto__")).toBe(false)
      // Present and ordinary absent headers behave as before.
      expect(response.headers.get("x-real")).toBe("yes")
      expect(response.headers.has("X-Real")).toBe(true)
      expect(response.headers.get("content-type")).toContain("text/plain")
      expect(response.headers.get("x-absent")).toBeNull()
      expect(response.headers.has("x-absent")).toBe(false)
      expect(response.headers.entries()).toContainEqual(["x-real", "yes"])
    } finally {
      server.stop()
    }
  })

  test("a header actually sent under a prototype name still resolves", async () => {
    const server = serve({ constructor: "sent-value" })
    try {
      const response = await webFetch(server.url)
      expect(response.headers.get("constructor")).toBe("sent-value")
      expect(response.headers.has("constructor")).toBe(true)
    } finally {
      server.stop()
    }
  })
})

describe("CodeModeWeb fetch response size cap (#923)", () => {
  test("rejects a body over the cap and serves a normal body unchanged", async () => {
    const big = Bun.serve({
      port: 0,
      fetch: () => new Response("x".repeat(CodeModeWeb.MAX_RESPONSE_BYTES + 1)),
    })
    try {
      await expect(webFetch(`http://127.0.0.1:${big.port}/`)).rejects.toThrow("Response too large")
    } finally {
      big.stop(true)
    }

    const streamed = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(CodeModeWeb.MAX_RESPONSE_BYTES + 1))
              controller.close()
            },
          }),
        ),
    })
    try {
      await expect(webFetch(`http://127.0.0.1:${streamed.port}/`)).rejects.toThrow("Response too large")
    } finally {
      streamed.stop(true)
    }

    const server = serve({ "content-type": "text/plain" })
    try {
      const response = await webFetch(server.url)
      expect(response.status).toBe(200)
    } finally {
      server.stop()
    }
  })
})
