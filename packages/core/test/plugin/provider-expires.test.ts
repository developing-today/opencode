import { describe, expect, test } from "bun:test"
import { expiresInSeconds, MAX_EXPIRES_IN_SECONDS } from "@opencode/core/plugin/provider/expires"

describe("expiresInSeconds (#879)", () => {
  test("a valid positive lifetime is stored verbatim", () => {
    expect(expiresInSeconds(7200, 3600)).toBe(7200)
    expect(expiresInSeconds(1, 3600)).toBe(1)
    expect(expiresInSeconds(MAX_EXPIRES_IN_SECONDS, 3600)).toBe(MAX_EXPIRES_IN_SECONDS)
  })

  test("negative and zero lifetimes take the provider fallback, not a past expiry", () => {
    expect(expiresInSeconds(-5, 7200)).toBe(7200)
    expect(expiresInSeconds(0, 600)).toBe(600)
  })

  test("absent and non-finite values take the fallback", () => {
    expect(expiresInSeconds(undefined, 3600)).toBe(3600)
    expect(expiresInSeconds(Number.NaN, 3600)).toBe(3600)
    expect(expiresInSeconds(Number.POSITIVE_INFINITY, 3600)).toBe(3600)
  })

  test("a milliseconds-confused lifetime takes the fallback instead of disabling refresh for weeks", () => {
    // 7200 seconds returned as 7200000 (ms) would otherwise store ~83 days.
    expect(expiresInSeconds(7_200_000, 7200)).toBe(7200)
    expect(expiresInSeconds(MAX_EXPIRES_IN_SECONDS + 1, 3600)).toBe(3600)
  })
})
