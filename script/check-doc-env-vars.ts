#!/usr/bin/env bun
/**
 * Fail when cli.mdx documents an OPENCODE_* variable that nothing reads (#116).
 *
 * The cli.mdx env tables are the canonical switch list users copy from, but
 * v1-era rows kept promising variables the v2 code never reads — setting one
 * silently did nothing (#103, #104, #105, #114, #115, #116). This guard
 * extracts every `OPENCODE_*` name mentioned in the English cli.mdx and
 * requires each one to appear somewhere outside the docs tree (code, config,
 * workflows, scripts — anywhere a reader or setter could live). The guard's
 * own files are excluded so its fixtures can never pose as a reader.
 *
 * Usage:
 *   bun run script/check-doc-env-vars.ts   # exit 1 listing dead variables
 *
 * Translations under packages/web/src/content/docs/<locale>/ follow the
 * usual docs-locale-sync flow and are not scanned, matching the English-only
 * scope of the fixes that removed the dead rows.
 */
import { join } from "node:path"

export const DOCS_PATH = "packages/web/src/content/docs/cli.mdx"

/** Every distinct OPENCODE_* name mentioned in a markdown document. */
export function documentedVars(markdown: string): string[] {
  return [...new Set(markdown.match(/\bOPENCODE_[A-Z0-9_]+\b/g) ?? [])].sort()
}

/** The documented variables for which `hasReader` finds no occurrence. */
export function deadVars(vars: string[], hasReader: (name: string) => boolean): string[] {
  return vars.filter((name) => !hasReader(name))
}

/**
 * A variable has a reader when git finds it outside the docs tree.
 * `-w` matches whole names only: without it a longer sibling such as
 * OPENCODE_CONFIG_DIR would pose as a reader of OPENCODE_CONFIG (#358).
 */
export function gitHasReader(root: string, name: string): boolean {
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      root,
      "grep",
      "-q",
      "-w",
      "-F",
      name,
      "--",
      ".",
      ":(exclude)packages/web/src/content/docs",
      ":(exclude)script/check-doc-env-vars.ts",
      ":(exclude)script/check-doc-env-vars.test.ts",
    ],
    { stdout: "ignore", stderr: "ignore" },
  )
  // git grep exits 1 when there is no match; anything else is a real error.
  if (result.exitCode === 1) return false
  if (result.exitCode !== 0) throw new Error(`git grep failed for ${name} (exit ${result.exitCode})`)
  return true
}

async function main() {
  const root = join(import.meta.dir, "..")
  const vars = documentedVars(await Bun.file(join(root, DOCS_PATH)).text())
  const dead = deadVars(vars, (name) => gitHasReader(root, name))
  if (dead.length) {
    console.error(`cli.mdx documents ${dead.length} OPENCODE_* variable(s) that nothing outside the docs reads:`)
    for (const name of dead) console.error(`  ${name}`)
    console.error("Remove the row, or implement the variable, before merging.")
    process.exit(1)
  }
  console.log(`All ${vars.length} OPENCODE_* variables documented in cli.mdx have a reader outside the docs.`)
}

if (import.meta.main) await main()
