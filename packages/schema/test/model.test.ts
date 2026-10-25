import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Model } from "../src/model.js"
import { Provider } from "../src/provider.js"

describe("Model.Ref", () => {
  test("parses model references with optional variants", () => {
    const variant = Model.Ref.parse("openrouter/openai/gpt-5#high")
    expect(String(variant.providerID)).toBe("openrouter")
    expect(String(variant.id)).toBe("openai/gpt-5")
    expect(String(variant.variant)).toBe("high")

    const standard = Model.Ref.parse("anthropic/claude-sonnet")
    expect(String(standard.providerID)).toBe("anthropic")
    expect(String(standard.id)).toBe("claude-sonnet")
    expect(standard.variant).toBeUndefined()
  })

  test("rejects malformed model references", () => {
    expect(() => Model.Ref.parse("gpt-5")).toThrow()
    expect(() => Model.Ref.parse("openai/gpt-5#")).toThrow()
    expect(() => Model.Ref.parse("openai/gpt-5#high#extra")).toThrow()
  })

  test("rejects padded, empty and internal-whitespace segments like ModelAlias (#456)", () => {
    for (const input of [
      "open ai/gpt-4",
      "openai/gpt 4",
      "openai/gpt\t4",
      "openai/gpt-4#hi there",
      " openai/gpt-4",
      "openai/gpt-4 ",
      "openai/gpt-4# hi",
      "openai//gpt-4",
      "openai/gpt-4#",
    ])
      expect(() => Model.Ref.parse(input)).toThrow(`Invalid model reference: ${input}`)
  })

  test("still accepts multi-slash model ids and variants (#456)", () => {
    const nested = Model.Ref.parse("openrouter/anthropic/claude-sonnet-4")
    expect(String(nested.providerID)).toBe("openrouter")
    expect(String(nested.id)).toBe("anthropic/claude-sonnet-4")
    expect(String(Model.Ref.parse("anthropic/claude-sonnet#high").variant)).toBe("high")
  })
})

describe("Model.ReasoningField", () => {
  test("accepts suggested and custom fields", () => {
    const decode = Schema.decodeUnknownSync(Model.ReasoningField)

    for (const field of ["reasoning", "reasoning_content", "reasoning_text", "vendor_reasoning"])
      expect(decode(field)).toBe(field)
  })
})

describe("Model.Compatibility", () => {
  test("decodes model compatibility overrides", () => {
    const decode = Schema.decodeUnknownSync(Model.Compatibility)

    expect(decode({})).toEqual({})
    expect(
      decode({
        reasoningField: "vendor_reasoning",
        requireReasoning: true,
        maxTokensField: "max_completion_tokens",
        requireFinishReason: false,
        requireAssistantAfterTool: true,
      }),
    ).toEqual({
      reasoningField: "vendor_reasoning",
      requireReasoning: true,
      maxTokensField: "max_completion_tokens",
      requireFinishReason: false,
      requireAssistantAfterTool: true,
    })
  })

  test("keeps capability overrides that gate protocol features", () => {
    const decode = Schema.decodeUnknownSync(Model.Compatibility)

    for (const supportsEffortUpdates of [false, true]) {
      expect(decode({ supportsEffortUpdates, supportsThinkingBlockBinding: true })).toEqual({
        supportsEffortUpdates,
        supportsThinkingBlockBinding: true,
      })
    }
  })

  test("omits undefined protocol capability overrides when encoded", () => {
    expect(
      Schema.encodeSync(Model.Compatibility)({
        supportsEffortUpdates: undefined,
        supportsThinkingBlockBinding: undefined,
      }),
    ).toEqual({})
  })
})

describe("Model.Info", () => {
  test("provider compaction policy is a typed setting", () => {
    const model = Model.Info.default(Provider.ID.openai, Model.ID.make("gpt-5.4-mini"))
    expect(Schema.encodeSync(Model.Info)({ ...model, settings: { compaction: undefined } }).settings).toEqual({})
    expect(
      Schema.decodeUnknownSync(Model.Info)({ ...model, settings: { compaction: { type: "native" } } }).settings,
    ).toEqual({
      compaction: { type: "native" },
    })
    expect(Schema.decodeUnknownSync(Provider.Compaction)({ type: "summary" })).toEqual({ type: "summary" })
    expect(() => Schema.decodeUnknownSync(Provider.Compaction)({ type: "automatic" })).toThrow()
  })

  test("uses practical token limits for unknown models", () => {
    const model = Model.Info.default(Provider.ID.make("custom"), Model.ID.make("gpt-5.6"))

    expect(model.limit).toEqual({ context: 200_000, output: 32_000 })
  })
})

describe("Model.Settings", () => {
  test("preserves provider-specific model options", () => {
    expect(Schema.decodeUnknownSync(Model.Settings)({ providerOption: true })).toEqual({
      providerOption: true,
    })
  })
})
