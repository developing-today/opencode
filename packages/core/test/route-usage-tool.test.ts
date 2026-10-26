import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelPlan } from "@opencode/core/model-plan"
import { RouteUsageTool } from "@opencode/core/tool/plugin/route-usage"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Schema } from "effect"

const NOW = Date.parse("2026-10-14T09:00:00.000Z")

const pool = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
  selection: "weighted",
  targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
  weights: { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
})

describe("route_usage without a history database", () => {
  test("lists configured members as unused, and plan windows with no usage shown as unknown", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-usage-"))
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      {
        providerID: "openai",
        plan: "Plus",
        quotas: [{ name: "5-hour", unit: "requests", limit: 100, windowHours: 5 }],
      },
      "2026-10-14T09:00:00.000Z",
    )
    ModelPlan.writeStore(store, dataDir)
    const report = await Effect.runPromise(
      RouteUsageTool.collect({ hours: 24 }, { routes: new Map([["cheap-fast", pool]]) }, { dataDir, now: () => NOW }),
    )
    expect(report.noDatabase).toBe(true)
    expect(report.targets.map((target) => target.target)).toEqual(["openai/gpt-6-luna", "github-copilot/gpt-6-luna"])
    expect(report.targets[0]?.pools).toEqual([
      { routeID: "cheap-fast", state: "configured-not-reached", offered: 0, chosen: 0 },
    ])
    expect(report.plans).toMatchObject([
      { plan: "openai-plus", window: "5-hour", used: null, percent: null, limit: 100 },
    ])
  })

  test("narrows to a pool named in any case", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-usage-"))
    const routes = new Map([["cheap-fast", pool]])
    const named = await Effect.runPromise(
      RouteUsageTool.collect({ route: "CHEAP-FAST" }, { routes }, { dataDir, now: () => NOW }),
    )
    expect(named.targets.map((target) => target.target)).toEqual(["openai/gpt-6-luna", "github-copilot/gpt-6-luna"])
    const other = await Effect.runPromise(
      RouteUsageTool.collect({ route: "other" }, { routes }, { dataDir, now: () => NOW }),
    )
    expect(other.targets).toEqual([])
  })

  test("a damaged plan file is reported, and usage still comes back", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "route-usage-"))
    fs.writeFileSync(path.join(dataDir, "plans.json"), "{")
    const report = await Effect.runPromise(RouteUsageTool.collect({}, undefined, { dataDir, now: () => NOW }))
    expect(report.planError).toContain("not valid JSON")
    expect(report.plans).toEqual([])
    expect(report.noDatabase).toBe(true)
  })
})
