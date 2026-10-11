import { spawn } from "node:child_process"

// A child that exits before it reads its stdin makes the write fail with EPIPE, or ERR_STREAM_DESTROYED once the
// stream is torn down. The child's exit status and output are the result, so this error is not a failure.
const closedPipe = (error: NodeJS.ErrnoException) => error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED"

// Runs a command with `input` on its stdin and resolves with its exit status and stderr. The stdin error listener
// stays attached for the child's life, so a closed-pipe error that lands after the write is not left unhandled.
export function runScript(
  command: string,
  args: readonly string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "ignore", "pipe"] })

    let stderr = ""
    child.stdin.on("error", (error) => {
      if (!closedPipe(error)) reject(error)
    })
    child.stderr.on("data", (chunk) => (stderr += chunk))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr }))
    child.stdin.end(input)
  })
}
