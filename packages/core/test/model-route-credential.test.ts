import { afterEach, describe, expect, test } from "bun:test"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteLog } from "@opencode/core/model-route-log"
import type { QuotaSnapshot } from "@opencode/core/quota-snapshot"

const target = ModelRoute.ref({ providerID: "opencode-go", model: "gpt-6-luna" })
const policy = ModelRoute.policy({ cooldownMs: 1_000, quotaCooldownMs: 15_000 })
const fast = { firstTokenMs: 100, responseMs: 500, tokensPerSecond: 30 }

const snap = (overrides: Partial<QuotaSnapshot.Snapshot> = {}): QuotaSnapshot.Snapshot => ({
  planID: "opencode-go-lab",
  window: "monthly",
  providerID: "opencode-go",
  percent: 100,
  remaining: 0,
  resetAt: 100_000,
  observedAt: 10_000,
  stale: false,
  ...overrides,
})

afterEach(() => {
  ModelRoute.resetHealth()
  ModelRouteLog.setSink(undefined)
})

describe("ModelRoute credential health (#6)", () => {
  test("a failure benches only the credential that served the attempt", () => {
    ModelRoute.failed(target, policy, 10_000, { quota: true }, "cred-lab")

    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 10_000)).toBe(25_000)
    expect(ModelRoute.credentialCoolingDown(target, "cred-lab", 24_999)).toBe(true)
    expect(ModelRoute.credentialCooldownUntil(target, "cred-personal", 10_000)).toBe(0)
    // The target itself is not benched: the other credential behind the provider stays routable.
    expect(ModelRoute.cooldownUntil(target, 10_000)).toBe(0)
    expect(ModelRoute.coolingDown(target, 10_000)).toBe(false)
  })

  test("credential benches escalate per consecutive failure and reset on success", () => {
    ModelRoute.failed(target, policy, 0, undefined, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 0)).toBe(1_000)
    ModelRoute.failed(target, policy, 2_000, undefined, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 2_000)).toBe(4_000)

    // A success after the bench expired clears it and resets the escalation count, exactly
    // like recover() on a target: an active bench is never lifted early.
    ModelRoute.completed(target, policy, fast, 4_000, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 4_000)).toBe(0)
    ModelRoute.failed(target, policy, 5_000, undefined, "cred-lab")
    expect(ModelRoute.credentialCooldownUntil(target, "cred-lab", 5_000)).toBe(6_000)
  })

  test("quota demotion counts per credential", () => {
    for (const at of [0, 1_000, 2_000]) ModelRoute.failed(target, policy, at, { quota: true }, "cred-lab")

    expect(ModelRoute.demoted(target, 2_000, "cred-lab")).toBe(true)
    expect(ModelRoute.demoted(target, 2_000, "cred-personal")).toBe(false)
    expect(ModelRoute.demoted(target, 2_000)).toBe(false)
  })
})

describe("ModelRoute credential quota gate (#6)", () => {
  test("a known-full credential is blocked until its reset, then re-admitted with a health record", () => {
    const events: ModelRouteLog.Event[] = []
    ModelRouteLog.setSink((event) => events.push(event))

    ModelRoute.observeCredentialQuota(target, "cred-lab", snap(), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 100_000 })
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 99_999)).toEqual({ until: 100_000 })
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 100_000)).toBeUndefined()
    expect(ModelRoute.credentialQuotaBlocked("cred-personal", 10_000)).toBeUndefined()

    const kinds = events.flatMap((event) => (event.kind === "health" ? [event.row.kind] : []))
    expect(kinds).toContain("quota-gated")
    expect(kinds).toContain("quota-readmitted")
  })

  test("a fresher good read re-admits before the reset", () => {
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap(), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })

    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 20_000 }),
      20_000,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toBeUndefined()
  })

  test("an older good read does not re-admit a credential gated by a newer full read", () => {
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ observedAt: 20_000 }), 20_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })

    // The below-limit reading was taken before the known-full one; delivered late, it is
    // still fresh (not stale) but must not rewind the gate.
    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 10_000 }),
      20_000,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })

    // A genuinely newer good read still re-admits.
    ModelRoute.observeCredentialQuota(
      target,
      "cred-lab",
      snap({ percent: 40, remaining: 60, observedAt: 30_000 }),
      30_000,
    )
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 30_000)).toBeUndefined()
  })

  test("unknown and stale readings never block, and never clear a known gate", () => {
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ percent: null, remaining: null }), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toBeUndefined()
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ stale: true }), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toBeUndefined()

    ModelRoute.observeCredentialQuota(target, "cred-lab", snap(), 10_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 10_000)).toEqual({ until: 100_000 })
    // Losing the signal is not a good read: the gate holds until the reset or a fresh snapshot.
    ModelRoute.observeCredentialQuota(target, "cred-lab", snap({ stale: true, observedAt: 20_000 }), 20_000)
    expect(ModelRoute.credentialQuotaBlocked("cred-lab", 20_000)).toEqual({ until: 100_000 })
  })
})
