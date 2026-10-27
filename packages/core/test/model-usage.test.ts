import { describe, expect, test } from "bun:test"
import { ModelPlan } from "@opencode/core/model-plan"
import { ModelUsage } from "@opencode/core/model-usage"

const totals = (overrides: Partial<ModelUsage.Totals> = {}): ModelUsage.Totals => ({
  requests: 1,
  failures: 0,
  input: 100,
  output: 50,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0.01,
  ...overrides,
})

describe("ModelUsage", () => {
  test("metered tokens are input, output and reasoning, with cache kept apart", () => {
    const row = totals({ input: 100, output: 50, reasoning: 10, cacheRead: 999, cacheWrite: 5 })
    expect(ModelUsage.metered(row)).toBe(160)
    expect(ModelUsage.usedOf("tokens", row)).toBe(160)
    expect(ModelUsage.usedOf("requests", row)).toBe(1)
    expect(ModelUsage.usedOf("messages", row)).toBe(1)
    expect(ModelUsage.usedOf("usd", row)).toBe(0.01)
    expect(ModelUsage.usedOf("percent", row)).toBeNull()
  })

  test("percent needs a positive limit", () => {
    expect(ModelUsage.percentOf(25, 100)).toBe(25)
    expect(ModelUsage.percentOf(1, 3)).toBe(33.3)
    expect(ModelUsage.percentOf(25, undefined)).toBeNull()
    expect(ModelUsage.percentOf(25, 0)).toBeNull()
  })

  test("target reports list every configured target, used or not, with the state of each pool it sits in", () => {
    const configured = new Map([
      ["cheap", ["openai/gpt-6-luna", "azure/gpt-6-luna", "zai/glm-5"]],
      ["hard", ["openai/gpt-6-luna"]],
    ])
    const offers = [
      { routeID: "cheap", target: "openai/gpt-6-luna", offered: 10, chosen: 7 },
      { routeID: "cheap", target: "azure/gpt-6-luna", offered: 10, chosen: 0 },
      { routeID: "hard", target: "openai/gpt-6-luna", offered: 0, chosen: 0 },
    ]
    const rows = [
      { providerID: "openai", modelID: "gpt-6-luna", sessions: 3, first: 1, last: 2, ...totals({ requests: 9 }) },
    ]
    const reports = ModelUsage.targetReports(
      rows,
      ["openai/gpt-6-luna", "azure/gpt-6-luna", "zai/glm-5"],
      offers,
      configured,
    )
    const openai = reports.find((report) => report.target === "openai/gpt-6-luna")
    expect(openai).toMatchObject({ requests: 9, sessions: 3, providerID: "openai", modelID: "gpt-6-luna" })
    expect(openai?.pools).toEqual([
      { routeID: "cheap", state: "used", offered: 10, chosen: 7 },
      { routeID: "hard", state: "configured-not-reached", offered: 0, chosen: 0 },
    ])
    expect(reports.find((report) => report.target === "azure/gpt-6-luna")?.pools).toEqual([
      { routeID: "cheap", state: "offered-not-chosen", offered: 10, chosen: 0 },
    ])
    expect(reports.find((report) => report.target === "zai/glm-5")).toMatchObject({
      requests: 0,
      providerID: "zai",
      modelID: "glm-5",
      pools: [{ routeID: "cheap", state: "configured-not-reached", offered: 0, chosen: 0 }],
    })
  })

  test("slash-less targets split as model with an empty provider, never a mangled provider", () => {
    expect(ModelUsage.splitTarget("openai/gpt-6-luna")).toEqual({ providerID: "openai", modelID: "gpt-6-luna" })
    // First slash wins: model ids may contain further slashes.
    expect(ModelUsage.splitTarget("openai/org/gpt-6")).toEqual({ providerID: "openai", modelID: "org/gpt-6" })
    expect(ModelUsage.splitTarget("gpt-5")).toEqual({ providerID: "", modelID: "gpt-5" })
    const reports = ModelUsage.targetReports([], ["gpt-5"], [], new Map())
    expect(reports).toMatchObject([{ target: "gpt-5", providerID: "", modelID: "gpt-5", requests: 0 }])
  })

  test("a session lists the pools and models it used, with their requests", () => {
    const sessions = [{ sessionID: "s1", first: 1, last: 9, ...totals({ requests: 3 }) }]
    const rows = [
      { sessionID: "s1", routeID: "cheap", providerID: "openai", modelID: "gpt-6-luna", ...totals({ requests: 2 }) },
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 1 }),
      },
      { sessionID: "s2", routeID: "cheap", providerID: "openai", modelID: "gpt-6-luna", ...totals() },
    ]
    const [report] = ModelUsage.sessionReports(sessions, rows)
    expect(report?.pools).toEqual(["cheap", "hard"])
    expect(report?.targets.map((item) => [item.target, item.requests])).toEqual([
      ["openai/gpt-6-luna", 2],
      ["anthropic/claude-opus-5", 1],
    ])
  })

  test("a session reports its share of each plan window it drew on, in the window's unit", () => {
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
    const window = { name: "5-hour", unit: "messages", limit: 200, windowHours: 5 } as ModelPlan.QuotaWindow
    const rows = [
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 50 }),
      },
      { sessionID: "s1", routeID: "cheap", providerID: "openai", modelID: "gpt-6-luna", ...totals({ requests: 10 }) },
    ]
    const [report] = ModelUsage.sessionReports(
      [{ sessionID: "s1", first: 1, last: 2, ...totals({ requests: 60 }) }],
      rows,
      [{ plan, window }],
    )
    expect(report?.windows).toEqual([
      { plan: "anthropic-max", window: "5-hour", unit: "messages", used: 50, percent: 25 },
    ])
  })

  test("a session's plan-window share counts only the rows inside the window's own lookback when given them", () => {
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
    const window = { name: "5-hour", unit: "messages", limit: 200, windowHours: 5 } as ModelPlan.QuotaWindow
    const reportRows = [
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 50 }),
      },
    ]
    const windowRows = [
      {
        sessionID: "s1",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 20 }),
      },
      {
        sessionID: "s2",
        routeID: "hard",
        providerID: "anthropic",
        modelID: "claude-opus-5",
        ...totals({ requests: 99 }),
      },
    ]
    const [report] = ModelUsage.sessionReports(
      [{ sessionID: "s1", first: 1, last: 2, ...totals({ requests: 60 }) }],
      reportRows,
      [{ plan, window, rows: windowRows }],
    )
    // 20 of the session's 50 anthropic requests fall inside the 5-hour lookback; s2's rows never count.
    expect(report?.windows).toEqual([
      { plan: "anthropic-max", window: "5-hour", unit: "messages", used: 20, percent: 10 },
    ])
    // The report-window targets still come from the report rows.
    expect(report?.targets.map((item) => [item.target, item.requests])).toEqual([["anthropic/claude-opus-5", 50]])
  })

  test("days group by date and keep each provider's share", () => {
    const days = ModelUsage.dayReports([
      { day: "2026-10-13", providerID: "openai", modelID: "a", ...totals({ requests: 2, costUsd: 0.5 }) },
      { day: "2026-10-13", providerID: "anthropic", modelID: "b", ...totals({ requests: 1, costUsd: 1 }) },
      { day: "2026-10-14", providerID: "openai", modelID: "a", ...totals() },
    ])
    expect(days.map((day) => day.day)).toEqual(["2026-10-13", "2026-10-14"])
    expect(days[0]).toMatchObject({
      requests: 3,
      costUsd: 1.5,
      providers: { openai: { requests: 2, costUsd: 0.5 }, anthropic: { requests: 1, costUsd: 1 } },
    })
  })

  test("a plan window reports what it has used, its percent and what remains", () => {
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
    expect(ModelUsage.windowReport(plan, window, totals({ requests: 50 }))).toMatchObject({
      plan: "anthropic-max",
      window: "5-hour",
      used: 50,
      limit: 200,
      percent: 25,
      remaining: 150,
      resetRule: "rolling",
    })
    expect(
      ModelUsage.windowReport(plan, { ...window, unit: "percent" } as ModelPlan.QuotaWindow, totals()).percent,
    ).toBeNull()
  })
})
