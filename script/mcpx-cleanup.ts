#!/usr/bin/env bun
/**
 * Remove mcpx daemons leaked by opencode test runs and short-lived processes (#14).
 *
 * A leaked daemon's HOME points into a temp directory (the test runner's
 * throwaway home) or at a directory that no longer exists, so `mcpx daemons`
 * and `mcpx stop --all` — which only see the real configuration's state dir —
 * cannot find it. This script scans the process table instead.
 *
 * Usage:
 *   bun run script/mcpx-cleanup.ts           # dry run: list leaked daemons
 *   bun run script/mcpx-cleanup.ts --apply   # stop them (SIGTERM, then SIGKILL)
 *
 * Only `mcpx daemon` processes whose HOME is under the OS temp dir or missing
 * are targeted. Daemons running under a real home are never touched.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type Daemon = { pid: number; home: string | undefined; owner: string | undefined }

// Path shapes differ per platform (macOS tmpdir() ends in a separator,
// Windows uses "\"), so temp-home detection works on the paths' own
// separator instead of assuming POSIX with no trailing separator.
const normalize = (path: string, windows: boolean): string => {
  const sep = windows ? "\\" : "/"
  const unified = windows ? path.replaceAll("/", "\\") : path
  const trimmed = unified.length > 1 ? unified.replace(/[\\/]+$/, "") : unified
  return windows ? trimmed.toLowerCase() : trimmed
}

export const isTempHome = (home: string, temp: string): boolean => {
  const windows = home.includes("\\") || temp.includes("\\")
  const sep = windows ? "\\" : "/"
  const normalizedHome = normalize(home, windows)
  const normalizedTemp = normalize(temp, windows)
  return normalizedHome === normalizedTemp || normalizedHome.startsWith(normalizedTemp + sep)
}

export const isLeaked = (home: string | undefined, temp: string, exists: (path: string) => boolean): boolean => {
  if (!home) return false
  return isTempHome(home, temp) || !exists(home)
}

// `ps eww` separates env entries with whitespace, so a value containing a
// space arrives as several tokens. A token only starts a new entry when it
// looks like `KEY=`; anything else continues the previous entry's value.
export const parsePsEnv = (raw: string): Map<string, string> => {
  const env = new Map<string, string>()
  let key: string | undefined
  for (const token of raw.split(/\s+/)) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=/)
    if (match) {
      key = match[1]!
      env.set(key, token.slice(match[0].length))
      continue
    }
    if (key && token) env.set(key, `${env.get(key)} ${token}`)
  }
  return env
}

export const parseEnv = (raw: string, platform: string): Map<string, string> => {
  if (platform !== "linux") return parsePsEnv(raw)
  const env = new Map<string, string>()
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=")
    if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1))
  }
  return env
}

const listDaemonPids = (): number[] => {
  if (process.platform === "linux") {
    return readdirSync("/proc")
      .filter((entry) => /^\d+$/.test(entry))
      .filter((entry) => {
        try {
          const cmdline = readFileSync(join("/proc", entry, "cmdline"), "utf-8").split("\0")
          return (cmdline[0]?.endsWith("mcpx") ?? false) && cmdline.includes("daemon")
        } catch {
          return false
        }
      })
      .map(Number)
  }
  const out = Bun.spawnSync(["ps", "-eo", "pid=,command="]).stdout.toString()
  return out.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S*mcpx)\s+daemon\b/)
    return match ? [Number(match[1])] : []
  })
}

const readEnv = (pid: number): Map<string, string> => {
  try {
    const raw =
      process.platform === "linux"
        ? readFileSync(join("/proc", String(pid), "environ"), "utf-8")
        : Bun.spawnSync(["ps", "eww", "-p", String(pid)]).stdout.toString()
    return parseEnv(raw, process.platform)
  } catch {
    return new Map<string, string>()
  }
}

const main = async () => {
  const apply = process.argv.includes("--apply")
  const daemons = listDaemonPids()
    .map((pid) => {
      const env = readEnv(pid)
      return { pid, home: env.get("HOME"), owner: env.get("MCPX_OWNER") }
    })
    .filter((daemon) => isLeaked(daemon.home, tmpdir(), existsSync))

  if (daemons.length === 0) {
    console.log("No leaked mcpx daemons found.")
    process.exit(0)
  }

  for (const daemon of daemons) {
    console.log(`pid ${daemon.pid}  HOME=${daemon.home}${daemon.owner ? `  MCPX_OWNER=${daemon.owner}` : ""}`)
  }

  if (!apply) {
    console.log(`\nDry run: ${daemons.length} leaked daemon(s). Re-run with --apply to stop them.`)
    process.exit(0)
  }

  for (const daemon of daemons) {
    // Daemons are spawned detached, so the pid is also the process-group id:
    // signalling the group also stops the MCP servers the daemon started.
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-daemon.pid, sig)
      } catch {
        try {
          process.kill(daemon.pid, sig)
        } catch {}
      }
    }
    signal("SIGTERM")
    await Bun.sleep(500)
    try {
      process.kill(daemon.pid, 0)
      signal("SIGKILL")
    } catch {}
    console.log(`stopped pid ${daemon.pid}`)
  }
}

if (import.meta.main) await main()
