import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { McpxTool } from "@opencode/core/tool/plugin/mcpx"

// Regression coverage for #14: activating the mcpx plugin used to spawn a
// detached `mcpx daemon` from every process — including tests, whose
// throwaway HOME meant one leaked daemon per test run, invisible to
// `mcpx daemons` once the temp home was deleted. Spawning is now gated
// (test processes and OPENCODE_MCPX_DAEMON=0 never spawn), the binary is
// pinnable via OPENCODE_MCPX_BIN, and spawned daemons carry a bounded idle
// lifetime plus an MCPX_OWNER tag.

const managed = [
  "OPENCODE_MCPX_BIN",
  "OPENCODE_MCPX_DAEMON",
  "OPENCODE_MCPX_DAEMON_IDLE_EXIT",
  "OPENCODE_TEST_HOME",
  "MCPX_DAEMON_ENDPOINT",
  "MCPX_ENDPOINT",
  "MCPX_SOCKET",
  "MCPX_STATE_DIR",
  "FAKE_MCPX_RECORD",
] as const

let saved: Record<string, string | undefined> = {}
let dir: string
let record: string

beforeEach(async () => {
  saved = Object.fromEntries(managed.map((name) => [name, process.env[name]]))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-mcpx-autostart-"))
  record = path.join(dir, "record.txt")
  // No daemon reachable: empty state dir, no endpoint, no socket override.
  process.env.MCPX_STATE_DIR = path.join(dir, "state")
  delete process.env.MCPX_DAEMON_ENDPOINT
  delete process.env.MCPX_ENDPOINT
  delete process.env.MCPX_SOCKET
  McpxTool.resetDaemonEnsured()
})

afterEach(async () => {
  for (const name of managed) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  McpxTool.resetDaemonEnsured()
  await fs.rm(dir, { recursive: true, force: true })
})

const exists = async (file: string): Promise<boolean> => {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

const fakeMcpx = async (): Promise<string> => {
  const bin = path.join(dir, "mcpx")
  await fs.writeFile(
    bin,
    [
      "#!/bin/sh",
      'printf \'args:%s\\n\' "$*" >> "$FAKE_MCPX_RECORD"',
      'printf \'owner:%s\\n\' "$MCPX_OWNER" >> "$FAKE_MCPX_RECORD"',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  process.env.OPENCODE_MCPX_BIN = bin
  process.env.FAKE_MCPX_RECORD = record
  return bin
}

describe("mcpx daemon autostart policy", () => {
  test("binary resolution prefers OPENCODE_MCPX_BIN", () => {
    expect(McpxTool.mcpxBinary({})).toBe("mcpx")
    expect(McpxTool.mcpxBinary({ OPENCODE_MCPX_BIN: "/opt/mcpx/bin/mcpx" })).toBe("/opt/mcpx/bin/mcpx")
  })

  test("autostart is off for tests and explicit opt-outs only", () => {
    expect(McpxTool.daemonAutostartEnabled({})).toBe(true)
    expect(McpxTool.daemonAutostartEnabled({ OPENCODE_TEST_HOME: "/tmp/oc-test" })).toBe(false)
    expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "0" })).toBe(false)
    expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "false" })).toBe(false)
    expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "off" })).toBe(false)
    expect(McpxTool.daemonAutostartEnabled({ OPENCODE_MCPX_DAEMON: "1" })).toBe(true)
  })

  test("spawn args bound the daemon's idle lifetime", () => {
    expect(McpxTool.daemonSpawnArgs({})).toEqual(["daemon", "--daemon-idle-exit", "1h"])
    expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "15m" })).toEqual([
      "daemon",
      "--daemon-idle-exit",
      "15m",
    ])
    expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "0" })).toEqual(["daemon"])
    expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "0s" })).toEqual(["daemon"])
    expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "1h30m" })).toEqual([
      "daemon",
      "--daemon-idle-exit",
      "1h30m",
    ])
    expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "1.5h" })).toEqual([
      "daemon",
      "--daemon-idle-exit",
      "1.5h",
    ])
  })

  test("spawn args fall back to the default with a warning for an invalid idle exit", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      for (const value of ["banana", "1 hour", "60", "1hr"]) {
        expect(McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: value })).toEqual([
          "daemon",
          "--daemon-idle-exit",
          "1h",
        ])
      }
      expect(warn).toHaveBeenCalledTimes(4)
      expect(warn.mock.calls[0]?.[0]).toContain("OPENCODE_MCPX_DAEMON_IDLE_EXIT")
      expect(warn.mock.calls[0]?.[0]).toContain("banana")
    } finally {
      warn.mockRestore()
    }
  })

  test("spawn args do not warn for a valid idle exit", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      McpxTool.daemonSpawnArgs({ OPENCODE_MCPX_DAEMON_IDLE_EXIT: "15m" })
      McpxTool.daemonSpawnArgs({})
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("ensureDaemon spawns nothing in a test process", async () => {
    await fakeMcpx()
    process.env.OPENCODE_TEST_HOME = dir
    await McpxTool.ensureDaemon()
    expect(await exists(record)).toBe(false)
  })

  test("ensureDaemon spawns nothing when OPENCODE_MCPX_DAEMON=0", async () => {
    await fakeMcpx()
    delete process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_MCPX_DAEMON = "0"
    await McpxTool.ensureDaemon()
    expect(await exists(record)).toBe(false)
  })

  test("ensureDaemon spawns the pinned binary with idle exit and owner tag", async () => {
    await fakeMcpx()
    delete process.env.OPENCODE_TEST_HOME
    delete process.env.OPENCODE_MCPX_DAEMON
    await McpxTool.ensureDaemon()
    const text = await fs.readFile(record, "utf-8")
    expect(text).toContain("args:daemon --daemon-idle-exit 1h")
    expect(text).toContain(`owner:opencode:${process.pid}`)
  })
})
