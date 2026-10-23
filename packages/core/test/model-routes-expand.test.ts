import { describe, expect, test } from "bun:test"
import { expand, routeVariants, routeWeightRules, weightRulesAcross } from "@opencode/core/config/plugin/model-routes"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { catalog as existingCatalog, routes as existingRoutes } from "./fixture/model-routes-existing"
import existingExpansion from "./fixture/model-routes-existing.expected.json"

const anthropic = Provider.ID.make("anthropic")
const openai = Provider.ID.make("openai")
const now = Date.now()

const models = (ids: string[]) =>
  new Map(ids.map((id) => [id, Model.Info.default(anthropic, Model.ID.make(id))] as const))

const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
  [anthropic, models(["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"])],
  [openai, models(["gpt-6-luna"])],
])

const selection = (reference: string) => {
  const [providerID, model] = reference.split("/")
  return { providerID, model }
}
const route = (targets: (string | { model: string; until?: number; variants?: Record<string, string> })[], extra: object = {}) =>
  new Map<string, ConfigModelRoutes.Route>([
    [
      "r",
      {
        targets: targets.map((target) =>
          typeof target === "string" ? selection(target) : { ...target, model: selection(target.model) },
        ),
        ...extra,
      } as unknown as ConfigModelRoutes.Route,
    ],
  ])

describe("pool targets", () => {
  // The expected file was captured from this expansion at 1668a0350b, before pools had matching keys,
  // effort levels or `false` remaps; the pinned-stack entry came later from dc951d46de, whose expansion code
  // is the same. It is the only check that those additions leave an older configuration exactly as it was;
  // regenerate it from one of those commits, never from the current code.
  test("a configuration without the new keys expands exactly as it did before they existed", () => {
    const expanded = Object.fromEntries(
      [...existingRoutes.keys()].map((id) => {
        const result = expand(id, existingRoutes, existingCatalog)
        return [
          id,
          {
            leaves: result.leaves.map((leaf) => ({
              ref: `${leaf.ref.providerID}/${leaf.ref.id}${leaf.ref.variant ? `#${leaf.ref.variant}` : ""}`,
              fixedVariant: leaf.fixedVariant,
              ...(leaf.defaultVariant ? { defaultVariant: leaf.defaultVariant } : {}),
              ...(leaf.variantMap ? { variantMap: leaf.variantMap } : {}),
              ...(leaf.budget ? { budget: leaf.budget } : {}),
            })),
            nodes: result.nodes,
            variants: routeVariants(result.leaves).map((variant) => String(variant.id)),
          },
        ]
      }),
    )
    expect(Object.keys(expanded)).toHaveLength(8)
    // The expected file is JSON, so the expansion is compared in its JSON form.
    expect(JSON.parse(JSON.stringify(expanded))).toEqual(existingExpansion)
  })

  test("a glob target joins every matching model of its provider, in provider order", () => {
    const { leaves } = expand("r", route(["anthropic/*sonnet*", "anthropic/*opus*"]), definitions)
    expect(leaves.map((leaf) => String(leaf.ref.id))).toEqual(["claude-sonnet-4-5", "claude-opus-4-1"])
  })

  test("a glob that matches nothing contributes nothing and does not fail the route", () => {
    const { leaves } = expand("r", route(["anthropic/*mistral*", "openai/gpt-6-luna"]), definitions)
    expect(leaves.map((leaf) => String(leaf.ref.id))).toEqual(["gpt-6-luna"])
  })

  test("a model reached by two targets appears once", () => {
    const { leaves } = expand("r", route(["anthropic/*sonnet*", "anthropic/claude-sonnet-4-5"]), definitions)
    expect(leaves).toHaveLength(1)
  })

  test("a time-limited target is in the route until its end time, then leaves it", () => {
    const live = { model: "anthropic/*opus*", until: now + 60_000 }
    const expired = { model: "openai/gpt-6-luna", until: now - 1 }
    const kept = expand("r", route([live, expired]), definitions)
    expect(kept.leaves.map((leaf) => String(leaf.ref.id))).toEqual(["claude-opus-4-1"])
  })
})

describe("advertised variants", () => {
  const withVariants = (providerID: Provider.ID, id: string, variants: string[]) =>
    [
      id,
      {
        ...Model.Info.default(providerID, Model.ID.make(id)),
        variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
      },
    ] as const

  test("a route offers a variant only when every target can produce it, natively or through a remap", () => {
    const definitionsWithVariants = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [anthropic, new Map([withVariants(anthropic, "claude-opus-4-1", ["high", "medium"])])],
      [openai, new Map([withVariants(openai, "gpt-6-luna", ["high"])])],
    ])
    const { leaves } = expand(
      "r",
      route([
        { model: "anthropic/claude-opus-4-1", variants: { low: "medium" } },
        { model: "openai/gpt-6-luna", variants: { low: "high" } },
      ]),
      definitionsWithVariants,
    )
    // `high` is native to both; `low` is remapped on both; `medium` only the first target has.
    expect(routeVariants(leaves).map((variant) => String(variant.id))).toEqual(["high", "low"])
  })
})

describe("pool weight schedules", () => {
  test("a route's schedule is normalized and carried on its node", () => {
    const routes = route(["openai/gpt-6-luna", "anthropic/claude-opus-4-1"], {
      schedules: [
        {
          id: "peak",
          targets: ["deepseek/*", "  "],
          when: { daysOfWeek: ["Mon", "fri"], start: "9:00", end: "17:00", timezone: "America/Chicago" },
          factor: 0.8,
          note: "peak hours",
        },
        { targets: ["*"], when: { timezone: "Mars/Olympus" }, factor: 10 },
        { targets: ["*"], when: { start: "09:00", end: "17:00" } },
      ],
    })
    const { nodes } = expand("r", routes, definitions)
    expect(nodes[0].schedules).toEqual([
      {
        id: "peak",
        match: { targets: ["deepseek/*"] },
        window: { daysOfWeek: [1, 5], start: "09:00", end: "17:00", timezone: "America/Chicago" },
        factor: 0.8,
        note: "peak hours",
      },
    ])
  })

  test("routeWeightRules drops an unreadable window instead of shifting weights at the wrong time", () => {
    expect(
      routeWeightRules({
        targets: [],
        schedules: [{ targets: ["*"], when: { start: "25:00" }, factor: 2 }],
      } as unknown as ConfigModelRoutes.Route),
    ).toEqual([])
  })

  test("a schedule with an empty day list applies every day instead of being dropped", () => {
    expect(
      routeWeightRules({
        targets: [],
        schedules: [{ id: "daily", targets: ["*"], when: { daysOfWeek: [], start: "09:00" }, factor: 2 }],
      } as unknown as ConfigModelRoutes.Route),
    ).toEqual([{ id: "daily", match: { targets: ["*"] }, window: { start: "09:00" }, factor: 2 }])
    expect(
      weightRulesAcross([{ when: { daysOfMonth: [] }, weight: 3 }] as unknown as ConfigModelRoutes.GlobalSchedule[]),
    ).toEqual([{ window: {}, weight: 3 }])
  })

  test("a global schedule keeps its matchers, including the route filter", () => {
    expect(
      weightRulesAcross([
        {
          id: "peak",
          providers: ["deepseek"],
          models: ["*chat*"],
          targets: ["deepseek/*"],
          routes: ["coding"],
          when: { daysOfWeek: ["mon"], start: "09:00", end: "17:00" },
          weight: 0.25,
        },
        { when: {}, factor: 2 },
      ] as unknown as ConfigModelRoutes.GlobalSchedule[]),
    ).toEqual([
      {
        id: "peak",
        match: { targets: ["deepseek/*"], providers: ["deepseek"], models: ["*chat*"], routes: ["coding"] },
        window: { daysOfWeek: [1], start: "09:00", end: "17:00" },
        weight: 0.25,
      },
      { window: {}, factor: 2 },
    ])
  })

  test("an always-on window keeps only the fields that were set", () => {
    const [rule] = weightRulesAcross([
      { when: { daysOfWeek: [0], start: "09:00" }, factor: 0.5 },
    ] as unknown as ConfigModelRoutes.GlobalSchedule[])
    expect(rule.window).toEqual({ daysOfWeek: [0], start: "09:00" })
  })
})
