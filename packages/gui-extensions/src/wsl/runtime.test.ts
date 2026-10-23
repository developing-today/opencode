import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { discoverScript } from "./remote-cli"
import { createWslRuntime, parseDiscoveredCli, parseProbeAnswer, probeScript, wslArgs } from "./runtime"

test("parseProbeAnswer reads the probe script's answer line, not login-shell banner output", () => {
  expect(parseProbeAnswer("yes")).toBe("yes")
  expect(parseProbeAnswer("no")).toBe("no")
  expect(parseProbeAnswer("Welcome to Ubuntu 24.04 LTS\nyes")).toBe("yes")
  expect(
    parseProbeAnswer("Last login: Thu Oct 22 00:01:02 2026\n * Documentation: https://help.ubuntu.com\nyes\n"),
  ).toBe("yes")
  expect(parseProbeAnswer("yes, your tools are ready\nno")).toBe("no")
  expect(parseProbeAnswer("")).toBe(null)
  expect(parseProbeAnswer("\n \n")).toBe(null)
})

test("probeScript prints both answers with a leading newline", () => {
  expect(probeScript("bash")).toContain(`printf '\\nyes\\n'`)
  expect(probeScript("bash")).toContain(`printf '\\nno\\n'`)
  expect(probeScript("curl")).toContain(`printf '\\nyes\\n'`)
  expect(probeScript("curl")).toContain(`printf '\\nno\\n'`)
})

// Runs the real probeScript through `sh`, optionally after preceding login-shell
// output (`precedingPrint` is a shell printf format string, so a test controls the
// trailing newline), and reads the output with the real parseProbeAnswer.
function runProbeScript(tool: string, precedingPrint?: string) {
  const script = precedingPrint === undefined ? probeScript(tool) : `printf '${precedingPrint}'\n${probeScript(tool)}`

  const result = spawnSync("sh", ["-s"], { input: script, encoding: "utf8" })

  if (result.status !== 0) throw new Error(`probeScript exited ${result.status}: ${result.stderr}`)

  return parseProbeAnswer(result.stdout)
}

test.skipIf(process.platform === "win32")(
  "probeDistro answers survive preceding login-shell output with no trailing newline, through the real probeScript",
  () => {
    for (const tool of ["bash", "curl"]) {
      expect(runProbeScript(tool)).toBe("yes")
      expect(runProbeScript(tool, "welcome to dev box\\n")).toBe("yes")
      expect(runProbeScript(tool, "welcome to dev box")).toBe("yes")
    }

    const missing = "opencode-definitely-missing-tool"

    expect(runProbeScript(missing)).toBe("no")
    expect(runProbeScript(missing, "welcome to dev box\\n")).toBe("no")
    expect(runProbeScript(missing, "welcome to dev box")).toBe("no")
    // A banner ending in `yes` must not become a false positive for a missing tool.
    expect(runProbeScript(missing, "your tools say yes")).toBe("no")
    expect(runProbeScript(missing, "yes")).toBe("no")
  },
)

test("parseDiscoveredCli returns the discovered path, not a login-shell banner line", () => {
  expect(parseDiscoveredCli("/home/user/.opencode/bin/opencode\n")).toBe("/home/user/.opencode/bin/opencode")
  expect(parseDiscoveredCli("Welcome to Ubuntu 24.04 LTS\n/home/user/.opencode/bin/opencode\n")).toBe(
    "/home/user/.opencode/bin/opencode",
  )
  expect(parseDiscoveredCli("")).toBeNull()
  expect(parseDiscoveredCli("Welcome to Ubuntu 24.04 LTS\n")).toBeNull()
  expect(parseDiscoveredCli("opencode\n")).toBeNull()
  // A banner line can itself be an absolute path to an `opencode` binary; the script's own
  // line comes after any banner, so the last path-shaped line is the discovered one.
  expect(parseDiscoveredCli("/opt/old-opencode/bin/opencode\n/home/user/.opencode/bin/opencode\n")).toBe(
    "/home/user/.opencode/bin/opencode",
  )
})

// Runs the real discoverScript through `sh` against a fake installed CLI,
// optionally after preceding login-shell output (`precedingPrint` is a shell
// printf format string, so a test controls the trailing newline), and reads
// the output with the real parseDiscoveredCli.
function runDiscoverScript(precedingPrint?: string) {
  const home = mkdtempSync(path.join(tmpdir(), "wsl-discover-cli-"))

  try {
    const cli = path.join(home, ".opencode/bin/opencode")

    mkdirSync(path.dirname(cli), { recursive: true })
    writeFileSync(cli, "#!/bin/sh\n")
    chmodSync(cli, 0o755)

    const script = precedingPrint === undefined ? discoverScript() : `printf '${precedingPrint}'\n${discoverScript()}`

    const result = spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    })

    if (result.status !== 0) throw new Error(`discoverScript exited ${result.status}: ${result.stderr}`)

    return { parsed: parseDiscoveredCli(result.stdout), cli }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test.skipIf(process.platform === "win32")(
  "parseDiscoveredCli reads the path when preceding login-shell output has no trailing newline, through the real discoverScript",
  () => {
    const unterminated = runDiscoverScript("welcome to dev box")

    expect(unterminated.parsed).toBe(unterminated.cli)

    const terminated = runDiscoverScript("welcome to dev box\\n")

    expect(terminated.parsed).toBe(terminated.cli)

    const clean = runDiscoverScript()

    expect(clean.parsed).toBe(clean.cli)
  },
)

test("wslArgs bypasses the distro default shell", () => {
  expect(wslArgs(["sh", "-lc", 'printf "%s\\n" "$HOME"'], "Debian")).toEqual([
    "-d",
    "Debian",
    "--exec",
    "sh",
    "-lc",
    'printf "%s\\n" "$HOME"',
  ])
  expect(wslArgs(["bash", "-se"], "Debian", "root")).toEqual([
    "-d",
    "Debian",
    "--user",
    "root",
    "--exec",
    "bash",
    "-se",
  ])
})

// Exercise the real wsl.exe argv path: with `--`, WSL routes the command line through the distro's
// default shell, which expands `$cli` to "" before `sh` runs the script (#48640).
const runtime = createWslRuntime((key) => key)

const distro =
  process.platform === "win32" && (await runtime.probeRuntime()).available
    ? (await runtime.listInstalled().catch(() => [])).find((item) => item.isDefault)?.name
    : undefined

// A cold WSL VM takes several seconds to answer.
test.skipIf(!distro)(
  "inline scripts keep their own variable expansion inside WSL",
  async () => {
    const result = await runtime.runWslSh(['cli="from-script"', 'printf "%s\\n" "$cli"'].join("\n"), distro)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe("from-script")
  },
  30_000,
)
