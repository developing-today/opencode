import { describe, expect, test } from "bun:test"
import { retry } from "./retry.js"

describe("client retry", () => {
  test("retries transient failures up to the configured attempt count", async () => {
    const failures: string[] = []
    const value = await retry(
      async () => {
        failures.push("attempt")
        if (failures.length < 3) throw new Error("Failed to fetch")
        return "ready"
      },
      { delay: 0 },
    )

    expect(value).toBe("ready")
    expect(failures).toHaveLength(3)
  })

  test("retries a real network failure wrapped as the cause of a transport error", async () => {
    // Drop the connection after the request arrives. Dropping it on accept can surface as a refused
    // connection, which makes the attempt count depend on timing.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.terminate()
        },
      },
    })
    const failures: unknown[] = []
    try {
      await expect(
        retry(
          () =>
            fetch(`http://127.0.0.1:${server.port}/api/project`).catch((cause) => {
              failures.push(cause)
              throw new Error("Transport", { cause })
            }),
          { delay: 0 },
        ),
      ).rejects.toThrow("Transport")
    } finally {
      server.stop(true)
    }
    expect(failures).toHaveLength(3)
    expect(failures.every((cause) => cause instanceof TypeError)).toBe(true)
  })

  test("retries a refused connection to a closed port", async () => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    const port = probe.port
    probe.stop(true)
    const failures: unknown[] = []
    await expect(
      retry(
        () =>
          fetch(`http://127.0.0.1:${port}/api/project`).catch((cause) => {
            failures.push(cause)
            throw new Error("Transport", { cause })
          }),
        { delay: 0 },
      ),
    ).rejects.toThrow("Transport")
    expect(failures).toHaveLength(3)
    expect(failures.every((cause) => cause instanceof TypeError)).toBe(true)
  })

  test("does not retry a transport error whose cause is not transient", async () => {
    const failures: string[] = []
    await expect(
      retry(async () => {
        failures.push("attempt")
        throw new Error("Transport", { cause: new Error("invalid response") })
      }),
    ).rejects.toThrow("Transport")
    expect(failures).toHaveLength(1)
  })

  test("does not retry other failures", async () => {
    const failures: string[] = []
    await expect(
      retry(async () => {
        failures.push("attempt")
        throw new Error("invalid response")
      }),
    ).rejects.toThrow("invalid response")
    expect(failures).toHaveLength(1)
  })

  test("uses a caller-owned retry condition", async () => {
    const failures: string[] = []
    await expect(
      retry(
        async () => {
          failures.push("attempt")
          throw new Error("retry me")
        },
        { attempts: 2, delay: 0, retryIf: () => true },
      ),
    ).rejects.toThrow("retry me")
    expect(failures).toHaveLength(2)
  })
})
