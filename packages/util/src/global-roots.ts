import os from "os"
import path from "path"

const home = os.homedir()
const data = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)

/**
 * The directory advertised as opencode's scratch space. `OPENCODE_TMPDIR`
 * overrides the swept OS temp directory with a durable location: the value is
 * used as-is (a leading `~` expands to the home directory and relative values
 * resolve against the working directory), so the advertised path is exactly
 * the configured one. Unset or blank keeps the OS temp default.
 */
export function tmpRoot(app: string) {
  const override = process.env.OPENCODE_TMPDIR?.trim()
  if (!override) return path.join(os.tmpdir(), app)
  const expanded = override === "~" ? home : override.startsWith("~/") ? path.join(home, override.slice(2)) : override
  return path.resolve(expanded)
}

/** The XDG base directories that root opencode's global paths. */
export function roots(app: string) {
  return {
    data: path.join(data!, app),
    cache: path.join(cache!, app),
    config: path.join(config!, app),
    state: path.join(state!, app),
    tmp: tmpRoot(app),
  }
}
