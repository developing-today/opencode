import { describe, expect, test } from "bun:test"
import { parseAllowlist, SCAN_ROOTS, scanSource, staleEntries, unlistedHits } from "./check-proto-reads"

describe("scanSource", () => {
  test("flags the P-A uppercase-table shape and the P-C ?? shape", () => {
    const hits = scanSource(
      "packages/core/src/example.ts",
      ["const a = TABLE[key]", "const b = weights[index] ?? 1", "const c = ownValue(TABLE, key)"].join("\n"),
    )
    expect(hits.map((hit) => hit.line)).toEqual([1, 2])
    expect(hits[0].text).toBe("const a = TABLE[key]")
  })

  test("a guarded hasOwn line still matches, so it needs a disposition", () => {
    const hits = scanSource("f.ts", "const arity = Object.hasOwn(ARITY, key) ? ARITY[key] : undefined")
    expect(hits).toHaveLength(1)
  })
})

describe("scan roots", () => {
  test("scans packages/ai in addition to packages/core (#912)", () => {
    expect(SCAN_ROOTS).toEqual(["packages/core/src", "packages/ai/src"])
  })
})

describe("allowlist accounting", () => {
  const hits = scanSource("f.ts", "const a = TABLE[key]")
  const allowlist = parseAllowlist("# comment\n\nf.ts :: const a = TABLE[key] :: guarded at the site\n")

  test("a listed hit passes and nothing is stale", () => {
    expect(unlistedHits(hits, allowlist)).toEqual([])
    expect(staleEntries(hits, allowlist)).toEqual([])
  })

  test("an unlisted hit fails; a vanished line makes its entry stale", () => {
    expect(unlistedHits(hits, new Map())).toHaveLength(1)
    expect(staleEntries([], allowlist)).toEqual(["f.ts :: const a = TABLE[key]"])
  })

  test("a malformed allowlist line throws", () => {
    expect(() => parseAllowlist("f.ts :: no disposition")).toThrow("Malformed allowlist line")
  })
})
