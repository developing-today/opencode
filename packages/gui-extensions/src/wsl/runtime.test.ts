import { expect, test } from "bun:test"
import { createWslRuntime, parseProbeAnswer, wslArgs } from "./runtime"

test("parseProbeAnswer reads the probe script's answer line, not login-shell banner output", () => {
  expect(parseProbeAnswer("yes")).toBe("yes")
  expect(parseProbeAnswer("no")).toBe("no")
  expect(parseProbeAnswer("Welcome to Ubuntu 24.04 LTS\nyes")).toBe("yes")
  expect(parseProbeAnswer("Last login: Thu Oct 22 00:01:02 2026\n * Documentation: https://help.ubuntu.com\nyes\n")).toBe(
    "yes",
  )
  expect(parseProbeAnswer("yes, your tools are ready\nno")).toBe("no")
  expect(parseProbeAnswer("")).toBe(null)
  expect(parseProbeAnswer("\n \n")).toBe(null)
})

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
