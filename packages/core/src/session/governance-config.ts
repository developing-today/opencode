export * as GovernanceConfig from "./governance-config.js"

import { Context, Effect, LayerMap, Option } from "effect"
import type { Entry } from "@opencode/schema/config"
import { Config } from "../config.js"
import type { Instance } from "../instance.js"
import { Location } from "../location.js"
import { Provider } from "../provider.js"
import { ModelGovernance } from "./model-governance.js"

export type Result = {
  entries: Entry[]
  catalog: ModelGovernance.Catalog | undefined
}

/**
 * The governance inputs for a location: its config entries plus the provider
 * catalog governance judges route targets against (#530). Read only from an
 * already-initialized location context — session operations never initialize
 * a location just to read them. An uninitialized location has no definition
 * layer and supplies no catalog, so route targets are judged literally; a
 * location with no provider service likewise supplies no catalog. Any failure
 * falls back to the empty result.
 *
 * This construction exists exactly once: the session-creation path
 * (session.ts) and the switchAgent / model-selection paths
 * (session/session.ts) must judge against the same catalog, or the same route
 * could be allowed by one entry point and denied by the other.
 */
export const load = (
  locations: LayerMap.LayerMap<Location.Ref, Instance.Services, Instance.Error> | undefined,
  location: Location.Ref,
): Effect.Effect<Result> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (locations === undefined)
        return { entries: [] as Entry[], catalog: undefined as ModelGovernance.Catalog | undefined }
      const context = yield* locations.contextEffectOption(location)
      if (Option.isNone(context))
        return { entries: [] as Entry[], catalog: undefined as ModelGovernance.Catalog | undefined }
      const config = Context.getOption(context.value, Config.Service)
      const entries = config._tag === "Some" ? yield* config.value.entries() : ([] as Entry[])
      const provider = Context.getOption(context.value, Provider.Service)
      if (provider._tag === "None") return { entries, catalog: undefined }
      const snapshot = yield* provider.value.snapshot()
      const catalog: ModelGovernance.Catalog = new Map(
        Array.from(snapshot.records, ([providerID, record]) => [
          providerID as string,
          new Map(
            Array.from(record.models, ([id, model]) => [
              id as string,
              { enabled: model.enabled, variants: model.variants },
            ]),
          ),
        ]),
      )
      return { entries, catalog }
    }),
  ).pipe(
    Effect.orElseSucceed(() => ({ entries: [] as Entry[], catalog: undefined as ModelGovernance.Catalog | undefined })),
  )
