import { describe, expect, test } from "bun:test"
import { ModelPlan } from "@opencode/core/model-plan"
import { ModelUsage } from "@opencode/core/model-usage"
import { QuotaSnapshot } from "@opencode/core/quota-snapshot"

const totals = (overrides: Partial<ModelUsage.Totals> = {}): ModelUsage.Totals => ({
  requests: 0,
  failures: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  ...overrides,
})

const plan = {
  id: "anthropic-max",
  providerID: "anthropic",
  label: "Personal",
  coverage: "subscription",
  quotas: [],
  status: "active",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} as ModelPlan.Plan

const window = {
  name: "5-hour",
  unit: "messages",
  limit: 200,
  windowHours: 5,
  resetRule: "rolling",
} as ModelPlan.QuotaWindow

const now = Date.parse("2026-10-27T12:00:00.000Z")

describe("QuotaSnapshot", () => {
  test("a normal window derives percent and remaining from windowReport", () => {
    // Hand-computed: 50 of a 200-message limit is 25%, leaving 150.
    const snapshot = QuotaSnapshot.derive({ plan, window, totals: totals({ requests: 50 }), observedAt: now }, { now })
    expect(snapshot).toEqual({
      planID: "anthropic-max",
      window: "5-hour",
      providerID: "anthropic",
      percent: 25,
      remaining: 150,
      resetAt: null,
      observedAt: now,
      stale: false,
    })
    expect(QuotaSnapshot.known(snapshot)).toBe(true)
  })

  test("a window with no limit yields percent null, never a guess", () => {
    const { limit: _limit, ...rest } = window
    const snapshot = QuotaSnapshot.derive(
      { plan, window: rest as ModelPlan.QuotaWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    expect(snapshot.percent).toBeNull()
    expect(snapshot.remaining).toBeNull()
    expect(QuotaSnapshot.known(snapshot)).toBe(false)
  })

  test("a window with no windowHours yields percent null even with a limit", () => {
    const { windowHours: _windowHours, ...rest } = window
    const snapshot = QuotaSnapshot.derive(
      { plan, window: rest as ModelPlan.QuotaWindow, totals: totals({ requests: 50 }), observedAt: now },
      { now },
    )
    expect(snapshot.percent).toBeNull()
    expect(snapshot.remaining).toBeNull()
  })

  test("an observation older than the configured max age is stale; a fresh one is not", () => {
    const input = { plan, window, totals: totals({ requests: 50 }) }
    const fresh = QuotaSnapshot.derive({ ...input, observedAt: now - 30 * 60_000 }, { now, maxAgeMs: 3_600_000 })
    const stale = QuotaSnapshot.derive({ ...input, observedAt: now - 61 * 60_000 }, { now, maxAgeMs: 3_600_000 })
    expect(fresh.stale).toBe(false)
    expect(stale.stale).toBe(true)
    expect(QuotaSnapshot.known(stale)).toBe(false)
    // The default max age is the same one hour, and a per-plan override replaces it for that plan.
    expect(QuotaSnapshot.derive({ ...input, observedAt: now - 61 * 60_000 }, { now }).stale).toBe(true)
    expect(
      QuotaSnapshot.derive(
        { ...input, observedAt: now - 61 * 60_000 },
        { now, perPlanMaxAgeMs: { "anthropic-max": 7_200_000 } },
      ).stale,
    ).toBe(false)
  })

  test("resetAt comes from an explicit resetAt or a daily rule, and is null for a rolling rule", () => {
    const explicit = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetAt: "2026-10-27T17:00:00.000Z" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(explicit.resetAt).toBe(Date.parse("2026-10-27T17:00:00.000Z"))

    const daily = QuotaSnapshot.derive(
      {
        plan,
        window: { ...window, resetRule: "daily 00:00 UTC" } as ModelPlan.QuotaWindow,
        totals: totals(),
        observedAt: now,
      },
      { now },
    )
    expect(daily.resetAt).toBe(Date.parse("2026-10-28T00:00:00.000Z"))

    const rolling = QuotaSnapshot.derive({ plan, window, totals: totals(), observedAt: now }, { now })
    expect(rolling.resetAt).toBeNull()
  })

  test("deriveAll yields one snapshot per window of every plan", () => {
    const plans = [
      { ...plan, quotas: [window, { ...window, name: "weekly" }] },
      { ...plan, id: "openai-plus", providerID: "openai", quotas: [window] },
    ] as ModelPlan.Plan[]
    const snapshots = QuotaSnapshot.deriveAll(plans, () => totals({ requests: 50 }), now, { now })
    expect(snapshots.map((snapshot) => `${snapshot.planID}/${snapshot.window}`)).toEqual([
      "anthropic-max/5-hour",
      "anthropic-max/weekly",
      "openai-plus/5-hour",
    ])
    expect(snapshots.every((snapshot) => snapshot.percent === 25)).toBe(true)
  })
})
