import { describe, expect, test } from "bun:test"
import { ModelRouteReview } from "@opencode/core/model-route-review"

const attempt = (
  routeID: string,
  target: string,
  overrides: Partial<ModelRouteReview.Attempt> = {},
): ModelRouteReview.Attempt => {
  const [providerID = "", modelID = ""] = target.split("/")
  return {
    routeID,
    providerID,
    modelID,
    sessionID: "s1",
    outcome: "success",
    errorTag: null,
    firstTokenMs: 800,
    tokensPerSecond: 70,
    tokensInput: 3000,
    ...overrides,
  }
}

const decision = (
  routeID: string,
  reason: string,
  candidates: string[],
  chosen: string,
  weights: Record<string, number> = {},
  excluded: { candidate: string; reason: string }[] = [],
): ModelRouteReview.Decision => ({
  routeID,
  sessionID: "s1",
  candidates,
  chosen,
  reason,
  detail: { weights, excluded },
})

const pool = (
  selection: ModelRouteReview.Configured["selection"],
  targets: string[],
  weights: Record<string, number> = {},
): ModelRouteReview.Configured => ({ selection, targets, weights })

describe("ModelRouteReview.summarize", () => {
  test("member speed median counts completed attempts only, as its doc states", () => {
    const [summary] = ModelRouteReview.summarize({
      attempts: [
        attempt("cheap", "a/x", { outcome: "success", tokensPerSecond: 10 }),
        attempt("cheap", "a/x", { outcome: "failure", tokensPerSecond: 1000 }),
        attempt("cheap", "a/x", { outcome: "timeout", tokensPerSecond: 2000 }),
        attempt("cheap", "a/x", { outcome: "interrupted", tokensPerSecond: 3000 }),
      ],
      decisions: [],
      configured: new Map([["cheap", pool("weighted", ["a/x"])]]),
    })
    // The failed, timed-out and interrupted attempts did produce output, so the writers record a
    // speed for them — but the median is documented as completed attempts only: the lone success.
    expect(summary?.members[0]?.tokensPerSecond).toBe(10)
    expect(summary?.members[0]?.attempts).toBe(4)
  })

  test("member speed is null when no attempt completed", () => {
    const [summary] = ModelRouteReview.summarize({
      attempts: [attempt("cheap", "a/x", { outcome: "failure", tokensPerSecond: 1000 })],
      decisions: [],
      configured: new Map([["cheap", pool("weighted", ["a/x"])]]),
    })
    expect(summary?.members[0]?.tokensPerSecond).toBeNull()
  })

  test("judges a weighted pool by its new-session draws, not by sticky turns", () => {
    const weights = { "a/x": 2, "b/y": 1 }
    const decisions = [
      ...Array.from({ length: 20 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "a/x", weights)),
      ...Array.from({ length: 10 }, () => decision("cheap", "drawn", ["a/x", "b/y"], "b/y", weights)),
      // Later turns of sessions already placed: sticky, so they say nothing about the weights.
      ...Array.from({ length: 60 }, () => decision("cheap", "sticky", ["a/x", "b/y"], "b/y", weights)),
    ]
    const [summary] = ModelRouteReview.summarize({
      attempts: [],
      decisions,
      configured: new Map([["cheap", pool("weighted", ["a/x", "b/y"], weights)]]),
    })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]).toMatchObject({
      configuredWeight: 2,
      offered: 90,
      chosen: 20,
      draws: 30,
      drawsWon: 20,
      expectedShare: 0.667,
      takeRate: 0.667,
    })
    expect(members["b/y"]).toMatchObject({
      configuredWeight: 1,
      offered: 90,
      chosen: 70,
      draws: 30,
      drawsWon: 10,
      expectedShare: 0.333,
      takeRate: 0.333,
    })
  })

  test("lists configured members that had no traffic, with the weight they were given", () => {
    const configured = new Map([["cheap", pool("ordered", ["a/x", "b/y", "c/z"], { "c/z": 3 })]])
    const [summary] = ModelRouteReview.summarize({
      attempts: [attempt("cheap", "a/x")],
      decisions: [decision("cheap", "ordered", ["a/x", "b/y"], "a/x")],
      configured,
    })
    expect(summary?.members.map((member) => member.target)).toEqual(["a/x", "b/y", "c/z"])
    expect(summary?.members[2]).toMatchObject({
      target: "c/z",
      configuredWeight: 3,
      attempts: 0,
      offered: 0,
      chosen: 0,
      failureRate: null,
      takeRate: null,
      expectedShare: null,
    })
  })

  test("counts why a member was left out, without the timestamp in the reason", () => {
    const decisions = [
      decision("cheap", "ordered", ["b/y"], "b/y", {}, [{ candidate: "a/x", reason: "cooldown-until:1767225600000" }]),
      decision("cheap", "ordered", ["b/y"], "b/y", {}, [
        { candidate: "a/x", reason: "soft-budget" },
        { candidate: "a/x", reason: "cooldown-until:1767225600000" },
      ]),
    ]
    const [summary] = ModelRouteReview.summarize({ attempts: [], decisions, configured: new Map() })
    const member = summary?.members.find((item) => item.target === "a/x")
    expect(member?.excluded).toEqual({ cooldown: 2, "soft-budget": 1 })
    expect(member).toMatchObject({ offered: 0, attempts: 0 })
  })

  test("reports failures, first output, speed and request size for each member", () => {
    const attempts = [
      attempt("cheap", "a/x", { firstTokenMs: 500, tokensPerSecond: 90 }),
      attempt("cheap", "a/x", { firstTokenMs: 600, tokensPerSecond: 80 }),
      attempt("cheap", "a/x", { firstTokenMs: 700, tokensPerSecond: 70 }),
      attempt("cheap", "a/x", { firstTokenMs: 800, tokensPerSecond: 60 }),
      attempt("cheap", "a/x", {
        outcome: "failure",
        errorTag: "ContextLengthExceeded",
        firstTokenMs: null,
        tokensPerSecond: null,
        tokensInput: 120_000,
      }),
    ]
    const [summary] = ModelRouteReview.summarize({ attempts, decisions: [], configured: new Map() })
    expect(summary?.members[0]).toMatchObject({
      attempts: 5,
      failures: 1,
      failureRate: 0.2,
      firstTokenMs: 600,
      tokensPerSecond: 70,
      inputTokens: 3000,
      errorTags: { ContextLengthExceeded: 1 },
    })
    expect(summary).toMatchObject({ attempts: 5, sessions: 1, inputTokens: { p50: 3000, p90: 120_000 } })
  })

  test("lists configured pools first, then pools seen only in history, busiest first", () => {
    const summaries = ModelRouteReview.summarize({
      attempts: [attempt("other", "a/x"), attempt("other", "a/x"), attempt("third", "b/y")],
      decisions: [],
      configured: new Map([["cheap", pool("ordered", ["a/x"])]]),
    })
    expect(summaries.map((summary) => summary.id)).toEqual(["cheap", "other", "third"])
    expect(summaries[1]?.configured).toBeNull()
  })

  test("surfaces the per-layer weight attribution of the most recent decision (#589)", () => {
    const layers = { base: 2, scheduled: 2, prefer: 6, adjustment: 6, demotion: 6, gate: null }
    const recorded: ModelRouteReview.Decision = {
      routeID: "cheap",
      sessionID: "s1",
      candidates: ["a/x", "b/y"],
      chosen: "a/x",
      reason: "adjusted",
      detail: { weights: { "a/x": 6, "b/y": 1 }, layers: { "a/x": layers }, excluded: [] },
    }
    const [summary] = ModelRouteReview.summarize({ attempts: [], decisions: [recorded], configured: new Map() })
    const members = Object.fromEntries((summary?.members ?? []).map((member) => [member.target, member]))
    expect(members["a/x"]?.weightLayers).toEqual(layers)
    expect(members["b/y"]?.weightLayers).toBeNull()
    expect(ModelRouteReview.layersOf(recorded.detail)).toEqual({ "a/x": layers })
    expect(ModelRouteReview.layersOf(null)).toEqual({})
    expect(ModelRouteReview.layersOf({ layers: { "a/x": { base: "heavy" } } })).toEqual({})
  })

  test("weightLayers comes from the newest decision that carries layers, not the oldest (#628)", () => {
    const newest = { base: 99, scheduled: 99, prefer: 99, adjustment: 99, demotion: 99, gate: null }
    const oldest = { base: 1, scheduled: 1, prefer: 1, adjustment: 1, demotion: 1, gate: null }
    const decision = (layers: unknown): ModelRouteReview.Decision => ({
      routeID: "cheap",
      sessionID: "s1",
      candidates: ["a/x"],
      chosen: "a/x",
      reason: "adjusted",
      detail: { weights: { "a/x": 1 }, ...(layers === undefined ? {} : { layers: { "a/x": layers } }), excluded: [] },
    })
    const layersOfSummary = (decisions: ModelRouteReview.Decision[]) =>
      ModelRouteReview.summarize({ attempts: [], decisions, configured: new Map() })[0]?.members[0]?.weightLayers
    // Production order is newest-first: the oldest decision must not overwrite the newest.
    expect(layersOfSummary([decision(newest), decision(oldest)])).toEqual(newest)
    // A newest decision without layers falls through to the next one that carries them.
    expect(layersOfSummary([decision(undefined), decision(newest), decision(oldest)])).toEqual(newest)
  })
})
