export * as GitHubProcess from "./process.js"

import { execFile } from "node:child_process"
import { Effect } from "effect"

export interface Result {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs a program without a shell. Never fails: a missing program or a timeout is a non-zero exit with stderr. */
export type Run = (
  command: string,
  args: ReadonlyArray<string>,
  options?: { readonly cwd?: string; readonly timeout?: number },
) => Effect.Effect<Result>

export const run: Run = (command, args, options = {}) =>
  Effect.callback<Result>((resume, signal) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, timeout: options.timeout ?? 30_000, signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) =>
        resume(
          Effect.succeed({
            exitCode: error ? (typeof error.code === "number" ? error.code : 127) : 0,
            stdout,
            stderr: stderr || (error ? error.message : ""),
          }),
        ),
    )
  })
