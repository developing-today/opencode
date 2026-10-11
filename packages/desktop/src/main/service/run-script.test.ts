import { describe, expect, test } from "bun:test"
import { runScript } from "./run-script"

// Larger than a pipe buffer, so the write is still pending when the child exits and closes its stdin.
const largeInput = "x".repeat(8 * 1024 * 1024)

describe("runScript", () => {
  test("resolves with the exit status of a child that exits before reading its stdin", async () => {
    const result = await runScript("/bin/sh", ["-c", "exit 0"], largeInput, process.env)

    expect(result).toEqual({ code: 0, stderr: "" })
  })

  test("reports the child's own exit status and stderr when it fails without reading stdin", async () => {
    const result = await runScript("/bin/sh", ["-c", "echo broken >&2; exit 3"], largeInput, process.env)

    expect(result).toEqual({ code: 3, stderr: "broken\n" })
  })

  test("passes stdin through to a child that reads it", async () => {
    const result = await runScript("/bin/sh", ["-s"], "exit 7", process.env)

    expect(result).toEqual({ code: 7, stderr: "" })
  })
})
