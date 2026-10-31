#!/usr/bin/env bun
/**
 * Regression net for the prototype-chain dictionary-read class (#865,
 * follow-up to the #833 audit).
 *
 * A bare `record[key]` read walks the prototype chain: an externally
 * supplied key like "constructor" resolves to an inherited member instead
 * of missing, and a `?? fallback` never fires because inherited members are
 * not nullish. The blessed fix is `ownValue`/`ownOr` from
 * packages/core/src/util/record.ts. This gate scans packages/core/src and
 * packages/ai/src (#912) with the two sweep patterns pinned on #833 —
 *   P-A: an uppercase plain-object table read by a variable key
 *   P-C: a bracket read with a `??` fallback (the most dangerous shape)
 * — and requires every hit to be listed in
 * script/check-proto-reads.allowlist.txt with its disposition (guarded at
 * the site, safe by construction with the reason, or tracked by an issue).
 * A new bare read fails the gate until a human dispositions it; an
 * allowlist entry whose line no longer exists is stale and also fails, so
 * the list cannot silently rot.
 *
 * Usage:
 *   bun run script/check-proto-reads.ts   # exit 1 listing unlisted/stale hits
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

export const SCAN_ROOTS = ["packages/core/src", "packages/ai/src"] as const
/** @deprecated single-root name kept for compatibility; use SCAN_ROOTS. */
export const SCAN_ROOT = SCAN_ROOTS[0]
export const ALLOWLIST_PATH = "script/check-proto-reads.allowlist.txt"

export const PATTERNS: RegExp[] = [/\b[A-Z][A-Z_0-9]{2,}\[[a-zA-Z_]/, /\[[a-zA-Z_.]+\] \?\?/]

export interface Hit {
  readonly file: string
  readonly line: number
  readonly text: string
}

export const hitKey = (file: string, text: string) => `${file} :: ${text}`

/** Every line of `source` matching a sweep pattern, as hits for `file`. */
export function scanSource(file: string, source: string): Hit[] {
  const hits: Hit[] = []
  source.split("\n").forEach((raw, index) => {
    const text = raw.trim()
    if (text && PATTERNS.some((pattern) => pattern.test(text))) hits.push({ file, line: index + 1, text })
  })
  return hits
}

/** Parse the allowlist: `file :: exact trimmed line :: disposition` per line. */
export function parseAllowlist(source: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const raw of source.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const parts = line.split(" :: ")
    if (parts.length < 3) throw new Error(`Malformed allowlist line (want file :: line :: disposition): ${line}`)
    entries.set(hitKey(parts[0], parts[1]), parts.slice(2).join(" :: "))
  }
  return entries
}

export const unlistedHits = (hits: Hit[], allowlist: Map<string, string>) =>
  hits.filter((hit) => !allowlist.has(hitKey(hit.file, hit.text)))

export const staleEntries = (hits: Hit[], allowlist: Map<string, string>) => {
  const keys = new Set(hits.map((hit) => hitKey(hit.file, hit.text)))
  return [...allowlist.keys()].filter((key) => !keys.has(key))
}

function collect(root: string, dir: string, hits: Hit[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collect(root, path, hits)
    else if (entry.name.endsWith(".ts"))
      hits.push(...scanSource(path.slice(root.length + 1), readFileSync(path, "utf8")))
  }
}

async function main() {
  const root = join(import.meta.dir, "..")
  const hits: Hit[] = []
  for (const scanRoot of SCAN_ROOTS) collect(root, join(root, scanRoot), hits)
  const allowlist = parseAllowlist(await Bun.file(join(root, ALLOWLIST_PATH)).text())
  const unlisted = unlistedHits(hits, allowlist)
  const stale = staleEntries(hits, allowlist)
  if (unlisted.length || stale.length) {
    for (const hit of unlisted)
      console.error(
        `Unlisted prototype-chain read candidate at ${hit.file}:${hit.line}:\n  ${hit.text}\n  Guard it with ownValue/ownOr (packages/core/src/util/record.ts), or add its disposition to ${ALLOWLIST_PATH}.`,
      )
    for (const key of stale)
      console.error(`Stale allowlist entry (the line no longer matches a sweep pattern): ${key}`)
    process.exit(1)
  }
  console.log(`All ${hits.length} prototype-chain read candidates in ${SCAN_ROOTS.join(", ")} are dispositioned in ${ALLOWLIST_PATH}.`)
}

if (import.meta.main) await main()
