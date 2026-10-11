import { describe, expect, test } from "bun:test"
import { expand, routeVariants } from "@opencode/core/config/plugin/model-routes"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"

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
const route = (targets: (string | { model: string; until?: number; variants?: Record<string, string> })[]) =>
  new Map<string, ConfigModelRoutes.Route>([
    [
      "r",
      {
        targets: targets.map((target) =>
          typeof target === "string" ? selection(target) : { ...target, model: selection(target.model) },
        ),
      } as unknown as ConfigModelRoutes.Route,
    ],
  ])

describe("pool targets", () => {
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
