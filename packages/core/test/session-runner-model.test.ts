import { describe, expect } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { AISDK } from "@opencode/core/aisdk"
import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { ID, Info, Model, Ref, VariantID } from "@opencode/core/model"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Info as ConfigInfo } from "@opencode/schema/config"
import { Npm } from "@opencode/util/npm"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

const catalog = Info.make({
  ...Info.default(Provider.ID.make("deepseek"), ID.make("deepseek-chat")),
  package: Provider.aisdk("@ai-sdk/openai"),
  variants: [{ id: VariantID.make("high") }, { id: VariantID.make("low") }],
})
const runtime = LanguageModel.make({ id: "deepseek-chat", provider: "deepseek", route: OpenAIChat.route })

const configInfo = Schema.decodeUnknownSync(ConfigInfo, { errors: "all", onExcessProperty: "ignore" })({
  aliases: {
    models: {
      flash: "deepseek/deepseek-chat#high",
    },
  },
})
const config = Layer.mock(Config.Service)({
  entries: () => Effect.succeed([{ type: "document", info: configInfo }]),
})
const resolver = ModelResolver.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Provider.Service, { get: () => Effect.undefined }),
      Layer.mock(Model.Service, {
        get: () => Effect.succeed(catalog),
        available: () => Effect.succeed([catalog]),
      }),
      Layer.mock(Integration.Service, {
        revision: () => 0,
        connection: { active: () => Effect.undefined },
      } as never),
      Layer.mock(Npm.Service, {}),
      Layer.mock(AISDK.Service, { model: () => Effect.succeed(runtime) } as never),
      config,
    ),
  ),
)
const it = testEffect(SessionRunnerModel.layer.pipe(Layer.provide(Layer.mergeAll(resolver, config))))

const session = (model: Ref) =>
  // The runner only reads the session's id and model selection.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  ({ id: SessionSchema.ID.make("ses_runner_model_test"), model }) as unknown as SessionSchema.Info

describe("SessionRunnerModel bare aliases", () => {
  it.effect("expands a bare-alias target with an empty model id through the configured aliases", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const resolved = yield* models.resolve(
        session(Ref.make({ providerID: Provider.ID.make("flash"), id: ID.make("") })),
        () => Effect.succeed([catalog]),
      )
      expect(resolved.ref).toEqual(
        Ref.make({
          providerID: Provider.ID.make("deepseek"),
          id: ID.make("deepseek-chat"),
          variant: VariantID.make("high"),
        }),
      )
    }),
  )

  it.effect("expands a bare-alias target that carries its own variant", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      // The target's variant ("low") deliberately differs from the alias
      // target's variant ("high" in flash -> deepseek/deepseek-chat#high):
      // the user's variant must win, not be replaced by the alias's.
      const resolved = yield* models.resolve(
        session(Ref.make({ providerID: Provider.ID.make("flash"), id: ID.make(""), variant: VariantID.make("low") })),
        () => Effect.succeed([catalog]),
      )
      expect(resolved.ref).toEqual(
        Ref.make({
          providerID: Provider.ID.make("deepseek"),
          id: ID.make("deepseek-chat"),
          variant: VariantID.make("low"),
        }),
      )
    }),
  )

  it.effect("names the original bare input when it is neither an alias nor a model", () =>
    Effect.gen(function* () {
      const models = yield* SessionRunnerModel.Service
      const error = yield* models
        .resolve(session(Ref.make({ providerID: Provider.ID.make("nope"), id: ID.make("") })), () =>
          Effect.succeed([catalog]),
        )
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      expect(error.message).toBe("Model unavailable: nope")
    }),
  )
})
