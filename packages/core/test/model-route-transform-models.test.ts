import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { retargetDefinition, expand, routeVariants } from "@opencode/core/config/plugin/model-routes"
import { Model } from "@opencode/core/model"
import { ModelRoute } from "@opencode/core/model-route"
import { ModelRouteExpansion } from "@opencode/core/model-route-expansion"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { withCurrentModels } from "@opencode/core/session/governance-config"
import type { ConfigModelRoutes } from "@opencode/schema/config/model-routes"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const azure = Provider.ID.make("azure")

const info = (id: string) => Model.Info.default(azure, Model.ID.make(id))

// Provider definitions as the provider transform sees them: the catalog only.
// A model transform later removes the catalog model and adds a deployment under
// its deployment name, exactly like the Azure transform (#236).
const catalog = new Map<string, Model.Info>([["gpt-5-base", info("gpt-5-base")]])
const current = new Map<string, Model.Info>([["prod-mini", info("prod-mini")]])

const editor = {
  provider: {
    list: () => [{ provider: Provider.Info.empty(azure), models: catalog }],
    get: () => undefined,
  },
  ids: (providerID: Provider.ID) => Array.from(current.keys()).map((id) => Model.ID.make(id)),
  get: (providerID: Provider.ID, modelID: Model.ID) => current.get(String(modelID)),
} as unknown as Parameters<typeof retargetDefinition>[2]

const routes = (targets: string[]) =>
  new Map<string, ConfigModelRoutes.Route>([
    [
      "r",
      {
        targets: targets.map((target) => {
          const [providerID, model] = target.split("/")
          return { providerID, model }
        }),
      } as unknown as ConfigModelRoutes.Route,
    ],
  ])

const stored = (routeMap: Map<string, ConfigModelRoutes.Route>) => {
  const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([[azure, catalog]])
  const { leaves, nodes } = expand("r", routeMap, definitions)
  return {
    id: Model.ID.make("r"),
    targets: leaves.map((leaf) => leaf.ref),
    targetVariants: leaves.map(() => ({})),
    health: ModelRoute.policy(),
    budgets: leaves.map(() => ({})),
    nodes,
  } satisfies ModelRoute.Definition
}

describe("retargetDefinition (#236)", () => {
  test("an explicit target naming a transform-created model is placed after retargeting", () => {
    const routeMap = routes(["azure/gpt-5-base", "azure/prod-mini"])
    const before = stored(routeMap)
    // The provider transform could only place the catalog model.
    expect(before.targets.map((target) => String(target.id))).toEqual(["gpt-5-base"])
    const next = retargetDefinition(before, routeMap, editor)
    expect(next?.definition?.targets.map((target) => `${target.providerID}/${target.id}`)).toEqual([
      "azure/gpt-5-base",
      "azure/prod-mini",
    ])
    // Parallel arrays stay parallel with the new leaf.
    expect(next?.definition?.targetVariants).toHaveLength(2)
    expect(next?.definition?.budgets).toHaveLength(2)
  })

  test("a glob target enumerates transform-created model ids as well as definition ids", () => {
    const routeMap = routes(["azure/*"])
    const next = retargetDefinition(stored(routeMap), routeMap, editor)
    expect(next?.definition?.targets.map((target) => String(target.id))).toEqual(["gpt-5-base", "prod-mini"])
  })

  test("a */* door-set target picks up transform-created models from every concrete door (#869)", () => {
    const other = Provider.ID.make("other")
    const otherCatalog = new Map<string, Model.Info>([["x", Model.Info.default(other, Model.ID.make("x"))]])
    // A provider-aware editor: ids/get answer only for the provider asked, so a
    // literal "*" lookup finds nothing \u2014 the retarget must ask each door.
    const awareEditor = {
      provider: {
        list: () => [
          { provider: Provider.Info.empty(azure), models: catalog },
          { provider: Provider.Info.empty(other), models: otherCatalog },
        ],
        get: () => undefined,
      },
      ids: (providerID: Provider.ID) =>
        providerID === azure ? Array.from(current.keys()).map((id) => Model.ID.make(id)) : [],
      get: (providerID: Provider.ID, modelID: Model.ID) =>
        providerID === azure ? current.get(String(modelID)) : undefined,
    } as unknown as Parameters<typeof retargetDefinition>[2]
    const routeMap = new Map<string, ConfigModelRoutes.Route>([
      ["r", { targets: [{ providerID: "*", model: "*" }] } as unknown as ConfigModelRoutes.Route],
    ])
    const definitions = new Map<Provider.ID, ReadonlyMap<string, Model.Info>>([
      [azure, catalog],
      [other, otherCatalog],
    ])
    const { leaves, nodes } = expand("r", routeMap, definitions)
    const before = {
      id: Model.ID.make("r"),
      targets: leaves.map((leaf) => leaf.ref),
      targetVariants: leaves.map(() => ({})),
      health: ModelRoute.policy(),
      budgets: leaves.map(() => ({})),
      nodes,
    } satisfies ModelRoute.Definition
    expect(before.targets.map((target) => `${target.providerID}/${target.id}`)).toEqual(["azure/gpt-5-base", "other/x"])
    const next = retargetDefinition(before, routeMap, awareEditor)
    // The transform-created azure/prod-mini joins the */* pool exactly as it does
    // for an explicitly enumerated azure/* target.
    expect(next?.definition?.targets.map((target) => `${target.providerID}/${target.id}`)).toEqual([
      "azure/gpt-5-base",
      "azure/prod-mini",
      "other/x",
    ])
  })

  test("a route whose targets are unchanged keeps its stored definition", () => {
    const routeMap = routes(["azure/gpt-5-base"])
    // No replacement definition, so the caller leaves the stored targets alone; the
    // advertised variants are still reported so a retarget can revise them (#869).
    expect(retargetDefinition(stored(routeMap), routeMap, editor)?.definition).toBeUndefined()
  })

  test("unchanged targets still refresh targetVariants when a transform adds a remapped variant", () => {
    const variantInfo = (id: string, variants: string[]) =>
      Model.Info.make({
        ...Model.Info.default(azure, Model.ID.make(id)),
        variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
      })
    // The catalog model offers neither variant, so the stored definition has no
    // remap for max; the transform then adds high to the same model.
    const catalogModel = new Map<string, Model.Info>([["gpt-5-base", variantInfo("gpt-5-base", [])]])
    const routeMap = new Map<string, ConfigModelRoutes.Route>([
      [
        "r",
        {
          targets: [{ model: { providerID: "azure", model: "gpt-5-base" }, variants: { max: "high" } }],
        } as unknown as ConfigModelRoutes.Route,
      ],
    ])
    const { leaves, nodes } = expand("r", routeMap, new Map([[azure, catalogModel]]))
    const before = {
      id: Model.ID.make("r"),
      targets: leaves.map((leaf) => leaf.ref),
      targetVariants: leaves.map(() => ({})),
      health: ModelRoute.policy(),
      budgets: leaves.map(() => ({})),
      nodes,
    } satisfies ModelRoute.Definition
    const transformEditor = {
      provider: { list: () => [{ provider: Provider.Info.empty(azure), models: catalogModel }] },
      ids: () => [Model.ID.make("gpt-5-base")],
      get: (_providerID: Provider.ID, modelID: Model.ID) =>
        String(modelID) === "gpt-5-base" ? variantInfo("gpt-5-base", ["high"]) : undefined,
    } as unknown as Parameters<typeof retargetDefinition>[2]
    const next = retargetDefinition(before, routeMap, transformEditor)
    // The target refs are identical, but the stored mapping was stale: without a
    // replacement definition the resolver would run the model bare under #max
    // instead of at the remapped #high.
    expect(next?.definition?.targets.map((target) => `${target.providerID}/${target.id}`)).toEqual([
      "azure/gpt-5-base",
    ])
    expect(next?.definition?.targetVariants).toEqual([{ map: { max: Model.VariantID.make("high") } }])
  })
})

describe("advertised variants after retargeting (#869)", () => {
  const variantInfo = (id: string, variants: string[]) =>
    Model.Info.make({
      ...Model.Info.default(azure, Model.ID.make(id)),
      variants: variants.map((variant) => ({ id: Model.VariantID.make(variant) })),
    })

  // The provider transform sees only the catalog model, so it advertises the variants that
  // model offers; the deployment the model transform adds may offer none of them.
  const advertised = (offered: string[], deploymentVariants: string[]) => {
    const catalogModel = new Map<string, Model.Info>([["gpt-5-base", variantInfo("gpt-5-base", offered)]])
    const deployment = new Map<string, Model.Info>([["prod-mini", variantInfo("prod-mini", deploymentVariants)]])
    const doorEditor = {
      provider: { list: () => [{ provider: Provider.Info.empty(azure), models: catalogModel }] },
      ids: () => Array.from(deployment.keys()).map((id) => Model.ID.make(id)),
      get: (_providerID: Provider.ID, modelID: Model.ID) => deployment.get(String(modelID)),
    } as unknown as Parameters<typeof retargetDefinition>[2]
    const routeMap = new Map<string, ConfigModelRoutes.Route>([
      ["r", { targets: [{ providerID: "*", model: "*" }] } as unknown as ConfigModelRoutes.Route],
    ])
    const { leaves, nodes } = expand("r", routeMap, new Map([[azure, catalogModel]]))
    const before = {
      id: Model.ID.make("r"),
      targets: leaves.map((leaf) => leaf.ref),
      targetVariants: leaves.map(() => ({})),
      health: ModelRoute.policy(),
      budgets: leaves.map(() => ({})),
      nodes,
    } satisfies ModelRoute.Definition
    return { before: routeVariants(leaves), next: retargetDefinition(before, routeMap, doorEditor) }
  }

  test("a variant the retargeted leaf cannot produce is dropped from the route", () => {
    const { before, next } = advertised(["max", "high"], [])
    // The provider transform advertised both: the deployment did not exist yet.
    expect(before.map((variant) => String(variant.id))).toEqual(["max", "high"])
    expect(next?.definition?.targets.map((target) => `${target.providerID}/${target.id}`)).toEqual([
      "azure/gpt-5-base",
      "azure/prod-mini",
    ])
    // Advertising #max would let the resolver run the deployment bare under it, and would
    // let an exclusion naming that deployment stop binding. The route offers nothing now.
    expect(next?.variants).toEqual([])
  })

  test("a variant every retargeted leaf can produce stays advertised", () => {
    const { next } = advertised(["max", "high"], ["max"])
    expect(next?.variants.map((variant) => String(variant.id))).toEqual(["max"])
  })
})

describe("withCurrentModels (#236)", () => {
  test("governance's catalog gains transform-created models, so globs can judge them", () => {
    const catalogMap = new Map([["azure", new Map([["gpt-5-base", { enabled: true, variants: [] }]])]])
    const merged = withCurrentModels(catalogMap, [info("prod-mini")])
    expect(ModelRouteExpansion.matchingModels("prod-*", merged.get("azure")).map(([id]) => id)).toEqual(["prod-mini"])
    expect(merged.get("azure")?.get("prod-mini")?.enabled).toBe(true)
    // The snapshot catalog is not mutated.
    expect(catalogMap.get("azure")?.has("prod-mini")).toBe(false)
  })
})

const it = testEffect(PluginTestLayer)

it.effect("Model.Editor.ids lists current ids without drafting, including transform-created models", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const providerID = Provider.ID.make("company")
    const seen: { before?: string[]; after?: string[] } = {}
    const source: Plugin.Generation = {
      id: "ids-source",
      revision: "1",
      effect: (ctx) =>
        ctx.provider
          .transform((editor) =>
            editor.add({
              info: { ...Provider.Info.empty(providerID), activation: "enabled" },
              models: [Model.Info.default(providerID, Model.ID.make("chat"))],
            }),
          )
          .pipe(Effect.asVoid),
    }
    const probe: Plugin.Generation = {
      id: "ids-probe",
      revision: "1",
      effect: (ctx) =>
        ctx.model
          .transform((editor) => {
            seen.before = editor.ids(providerID).map(String)
            editor.update(providerID, Model.ID.make("deployment-1"), () => {})
            seen.after = editor.ids(providerID).map(String)
          })
          .pipe(Effect.asVoid),
    }
    yield* plugins.activate([source, probe])
    const models = yield* Model.Service
    yield* models.all()
    expect(seen.before).toEqual(["chat"])
    expect(seen.after).toEqual(["chat", "deployment-1"])
  }),
)
