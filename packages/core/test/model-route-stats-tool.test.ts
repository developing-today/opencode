import { describe, expect, test } from "bun:test"
import { RouteStatsTool } from "@opencode/core/tool/plugin/route-stats"
import { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { Effect, Schema } from "effect"

/** A pool written the way a config file writes it, decoded the way the config loader decodes it. */
const pool = Schema.decodeUnknownSync(ConfigModelRoutes.Route)({
  selection: "weighted",
  autonomy: "agent",
  targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
  weights: { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
})

describe("route_stats configuration view", () => {
  test("reports configured pools and tuner notes without a history database", async () => {
    const notes = ["openai/gpt-6-luna: out of quota, back in 3 hours"]
    const report = await Effect.runPromise(
      RouteStatsTool.collect({ hours: 24 }, { routes: new Map([["cheap-fast", pool]]), notes }),
    )
    expect(report.noDatabase).toBe(true)
    expect(report.notes).toEqual(notes)
    expect(report.routes).toHaveLength(1)
    expect(report.routes[0]).toMatchObject({
      id: "cheap-fast",
      attempts: 0,
      configured: {
        selection: "weighted",
        autonomy: "agent",
        targets: ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
      },
    })
    expect(report.routes[0]?.members).toMatchObject([
      { target: "openai/gpt-6-luna", configuredWeight: 3, attempts: 0 },
      { target: "github-copilot/gpt-6-luna", configuredWeight: 1, attempts: 0 },
    ])
  })

  test("narrows the per-pool view to the route asked for", async () => {
    const report = await Effect.runPromise(
      RouteStatsTool.collect({ route: "other" }, { routes: new Map([["cheap-fast", pool]]), notes: [] }),
    )
    expect(report.routes).toEqual([])
  })
})
