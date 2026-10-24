import { describe, expect, test } from "bun:test"
import { runScript } from "./run-script"

// Larger than a pipe buffer, so the write is still pending when the child exits and closes its stdin.
const largeInput = "x".repeat(8 * 1024 * 1024)

// The child is the current runtime executable running a small -e program, not a POSIX shell: /bin/sh does
// not exist on Windows, so the shell version of these tests died with ENOENT before exercising runScript.
const runProgram = (program: string, input: string) => runScript(process.execPath, ["-e", program], input, process.env)

describe("runScript", () => {
  test("resolves with the exit status of a child that exits before reading its stdin", async () => {
    const result = await runProgram("process.exit(0)", largeInput)

    expect(result).toEqual({ code: 0, stderr: "" })
  })

  test("reports the child's own exit status and stderr when it fails without reading stdin", async () => {
    const result = await runProgram('process.stderr.write("broken\\n", () => process.exit(3))', largeInput)

    expect(result).toEqual({ code: 3, stderr: "broken\n" })
  })

  test("passes stdin through to a child that reads it", async () => {
    const program = [
      'let data = ""',
      'process.stdin.setEncoding("utf8")',
      'process.stdin.on("data", (chunk) => (data += chunk))',
      'process.stdin.on("end", () => process.exit(data === "stdin reaches the child" ? 7 : 1))',
    ].join("; ")

    const result = await runProgram(program, "stdin reaches the child")

    expect(result).toEqual({ code: 7, stderr: "" })
  })
})
