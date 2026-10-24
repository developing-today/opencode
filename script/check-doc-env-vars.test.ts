import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deadVars, documentedVars, gitHasReader } from "./check-doc-env-vars"

describe("documentedVars", () => {
  test("extracts distinct OPENCODE_* names, sorted", () => {
    const md = [
      "| `OPENCODE_ZULU` | boolean | last |",
      "Set `OPENCODE_ALPHA` and again `OPENCODE_ZULU`.",
      "Not a variable: OPENCODE has no suffix, and `NOT_OPENCODE_X` is a different name.",
    ].join("\n")
    expect(documentedVars(md)).toEqual(["OPENCODE_ALPHA", "OPENCODE_ZULU"])
  })

  test("returns an empty list when nothing is documented", () => {
    expect(documentedVars("no variables here")).toEqual([])
  })
})

const scratchRepos: string[] = []

afterAll(() => {
  for (const root of scratchRepos) rmSync(root, { recursive: true, force: true })
})

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`)
}

/** A committed one-file git repo whose only content is `contents`. */
function repoWith(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "check-doc-env-vars-"))
  scratchRepos.push(root)
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  writeFileSync(join(root, "reader.txt"), contents)
  git(root, ["add", "."])
  git(root, ["commit", "-qm", "init"])
  return root
}

describe("gitHasReader", () => {
  test("a longer sibling name alone is not a reader (#358)", () => {
    const root = repoWith("OPENCODE_CONFIG_DIR\nOPENCODE_DISABLE_CLAUDE_CODE_SKILLS\n")
    expect(gitHasReader(root, "OPENCODE_CONFIG")).toBe(false)
    expect(gitHasReader(root, "OPENCODE_DISABLE_CLAUDE_CODE")).toBe(false)
  })

  test("the longer sibling itself still counts as read", () => {
    const root = repoWith("OPENCODE_CONFIG_DIR\n")
    expect(gitHasReader(root, "OPENCODE_CONFIG_DIR")).toBe(true)
  })

  test("exact occurrence shapes count as readers", () => {
    for (const shape of ["OPENCODE_CONFIG=/tmp/config", '"OPENCODE_CONFIG"', "${OPENCODE_CONFIG}", "OPENCODE_CONFIG"]) {
      expect(gitHasReader(repoWith(`${shape}\n`), "OPENCODE_CONFIG")).toBe(true)
    }
  })
})

describe("deadVars", () => {
  test("keeps only variables with no reader", () => {
    const readers = new Set(["OPENCODE_READ_SOMEWHERE"])
    expect(deadVars(["OPENCODE_READ_SOMEWHERE", "OPENCODE_READ_NOWHERE"], (name) => readers.has(name))).toEqual([
      "OPENCODE_READ_NOWHERE",
    ])
  })

  test("is empty when every variable has a reader", () => {
    expect(deadVars(["OPENCODE_READ_SOMEWHERE"], () => true)).toEqual([])
  })
})
