import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Real `serve` processes: a parent going away, SIGHUP, and SIGTERM only mean something across processes.

const entry = path.join(import.meta.dir, "../src/index.ts")
const serveTest = process.platform === "win32" ? test.skip : test
const password = "serve-survival-password"
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`

serveTest(
  "serve keeps answering after its parent closes the output pipes",
  async () => {
    await using server = await serve()
    await ready(server.url)

    await server.detachOutput()
    await Bun.sleep(500)
    await ready(server.url)

    expect(server.child.exitCode).toBeNull()
  },
  120_000,
)

serveTest(
  "SIGHUP refreshes configuration without stopping the server",
  async () => {
    await using server = await serve()
    await ready(server.url)

    server.child.kill("SIGHUP")
    await Bun.sleep(1_000)

    expect(server.child.exitCode).toBeNull()
    await ready(server.url)
  },
  120_000,
)

serveTest(
  "SIGTERM stops an idle server promptly",
  async () => {
    await using server = await serve()
    await ready(server.url)

    server.child.kill("SIGTERM")
    const outcome = await Promise.race([server.child.exited, Bun.sleep(15_000).then(() => "timeout" as const)])

    expect(outcome).not.toBe("timeout")
  },
  120_000,
)

async function serve() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-serve-survival-")))
  const child = Bun.spawn([process.execPath, entry, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    env: isolatedEnv(root, { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SHUTDOWN_GRACE_MS: "1000" }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = child.stdout.getReader()
  const stderr = child.stderr.getReader()
  void drain(stderr)
  const url = await listeningURL(stdout)
  return {
    child,
    url,
    detachOutput: () => Promise.all([stdout.cancel(), stderr.cancel()]),
    async [Symbol.asyncDispose]() {
      if (child.exitCode === null) child.kill("SIGKILL")
      await child.exited
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function listeningURL(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder()
  let output = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`serve exited before listening: ${output}`)
    output += decoder.decode(value, { stream: true })
    const match = /server listening on (http:\/\/\S+)/.exec(output)
    if (match) return match[1]!
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done) continue
}

async function ready(url: string) {
  const deadline = Date.now() + 60_000
  while (true) {
    const status = await fetch(`${url}/api/location`, { headers: { authorization } })
      .then((response) => response.status)
      .catch(() => undefined)
    if (status !== undefined && status !== 503) return status
    if (Date.now() > deadline) throw new Error(`server at ${url} never became ready`)
    await Bun.sleep(200)
  }
}
