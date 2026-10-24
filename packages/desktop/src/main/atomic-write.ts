import fs from "node:fs"
import path from "node:path"

const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])

const renameRetryDelays = [10, 25, 50, 100]

const renameWait = new Int32Array(new SharedArrayBuffer(4))

// On Windows, renaming over a destination another handle is reading fails
// with EPERM and the update would be lost; retry briefly before giving up
// (same fix as #85 for the TUI persistence helper, kept in sync with the
// core copy in packages/core/src/model-plan.ts).
export function renameSyncWithRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, destination)

      return
    } catch (error) {
      const delay = renameRetryDelays[attempt]

      // SAFETY: a failed fs rename throws a NodeJS.ErrnoException whose code names the failure;
      // a thrown value without one is not a rename failure and is rethrown as non-transient below.
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined

      if (delay === undefined || code === undefined || !transientRenameCodes.has(code)) throw error
      Atomics.wait(renameWait, 0, 0, delay)
    }
  }
}

// Writes content to a temp file beside the destination, then renames it
// over the destination. On failure the temp file is removed and the
// original error propagates.
export function writeFileSyncAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp`

  try {
    fs.writeFileSync(temporary, content)
    renameSyncWithRetry(temporary, file)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {}

    throw error
  }
}
