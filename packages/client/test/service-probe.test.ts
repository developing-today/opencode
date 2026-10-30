import { expect, test } from "bun:test"
import { maxProbeBodyBytes, probeResult } from "../src/service-probe"

const info = { url: "http://127.0.0.1:9", pid: 4242, version: "1.2.3" }

test("a small info body classifies as ready and compatible", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ version: "1.2.3", pid: 4242 })) as typeof fetch
  try {
    const result = await probeResult(info)
    expect(result.timedOut).toBe(false)
    expect(result.service).toMatchObject({ state: "ready", compatible: true, version: "1.2.3" })
  } finally {
    globalThis.fetch = original
  }
})

test("an over-cap declared length is rejected without consuming the body", async () => {
  let pulled = 0
  const totalChunks = 20
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1
      controller.enqueue(new TextEncoder().encode('{"version":"1.2.3","pid":4242}'))
      if (pulled >= totalChunks) controller.close()
    },
  })
  const response = new Response(stream, {
    headers: { "content-length": String(maxProbeBodyBytes + 1) },
  })
  const original = globalThis.fetch
  globalThis.fetch = (async () => response) as typeof fetch
  try {
    const result = await probeResult(info)
    expect(result.service).toBeUndefined()
    expect(result.timedOut).toBe(false)
    // The underlying stream may prefetch one chunk on construction; the point
    // is the declared over-cap body is cancelled, not drained.
    expect(pulled).toBeLessThanOrEqual(1)
  } finally {
    globalThis.fetch = original
  }
})

test("an over-cap streamed body is rejected in flight with cancel", async () => {
  const chunk = new TextEncoder().encode("x".repeat(8_192))
  const totalChunks = 20
  let pulled = 0
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1
      if (pulled <= totalChunks) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() {
      cancelled = true
    },
  })
  const response = new Response(stream)
  const original = globalThis.fetch
  globalThis.fetch = (async () => response) as typeof fetch
  try {
    const result = await probeResult(info)
    expect(result.service).toBeUndefined()
    expect(result.timedOut).toBe(false)
    expect(pulled).toBeLessThan(totalChunks)
    expect(cancelled).toBe(true)
  } finally {
    globalThis.fetch = original
  }
})
