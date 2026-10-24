import { describe, expect, test } from "bun:test"
import { ModelAlias, AliasCycleError, AliasMaxDepthError } from "../src/model-alias.js"

describe("ModelAlias", () => {
  const sampleAliases: ModelAlias.Aliases = {
    providers: {
      ds: "deepseek",
      cf: "cloudflare-gateway",
    },
    models: {
      flash: "deepseek/deepseek-chat#high",
      "deepseek/pro": "deepseek-v4-pro",
      "cf/fast": "deepseek/deepseek-chat",
    },
    variants: {
      hi: "high",
      "deepseek/*#hi": "max",
      "*/gpt-6-luna#hi": "xhigh",
      "deepseek/deepseek-chat#lo": "low",
    },
  }

  test("1. Global model alias resolves correctly", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "flash")
    expect(resolved).toBe("deepseek/deepseek-chat#high")
  })

  test("2. Explicit variant overrides global alias's default variant", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "flash#minimal")
    expect(resolved).toBe("deepseek/deepseek-chat#minimal")
  })

  test("3. Provider alias resolves correctly", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "ds/deepseek-chat")
    expect(resolved).toBe("deepseek/deepseek-chat")
  })

  test("4. Provider-scoped model alias resolves correctly", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "deepseek/pro")
    expect(resolved).toBe("deepseek/deepseek-v4-pro")
  })

  test("5. Provider alias + scoped model alias together", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "ds/pro")
    expect(resolved).toBe("deepseek/deepseek-v4-pro")
  })

  test("6. Bare effort alias resolves across all providers and models", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "anthropic/claude-3-5-sonnet#hi")
    expect(resolved).toBe("anthropic/claude-3-5-sonnet#high")
  })

  test("7. Provider effort alias overrides bare effort alias", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "deepseek/other-model#hi")
    expect(resolved).toBe("deepseek/other-model#max")
  })

  test("8. Model effort alias overrides provider and bare effort aliases", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "openai/gpt-6-luna#hi")
    expect(resolved).toBe("openai/gpt-6-luna#xhigh")
  })

  test("9. Provider model effort alias has the highest precedence", () => {
    // deepseek/deepseek-chat#lo -> low
    const resolved = ModelAlias.resolve(sampleAliases, "flash#lo")
    expect(resolved).toBe("deepseek/deepseek-chat#low")
  })

  test("10. Full precedence hierarchy check", () => {
    const aliases: ModelAlias.Aliases = {
      variants: {
        effort1: "bare-effort",
        "*/*#effort1": "wildcard-effort",
        "provider1/*#effort1": "provider-effort",
        "*/model1#effort1": "model-effort",
        "provider1/model1#effort1": "provider-model-effort",
      },
    }

    // Most specific matches: provider1/model1#effort1
    expect(ModelAlias.resolve(aliases, "provider1/model1#effort1")).toBe("provider1/model1#provider-model-effort")

    // Model effort: provider2/model1#effort1
    expect(ModelAlias.resolve(aliases, "provider2/model1#effort1")).toBe("provider2/model1#model-effort")

    // Provider effort: provider1/model2#effort1
    expect(ModelAlias.resolve(aliases, "provider1/model2#effort1")).toBe("provider1/model2#provider-effort")

    // Global effort: provider2/model2#effort1
    expect(ModelAlias.resolve(aliases, "provider2/model2#effort1")).toBe("provider2/model2#wildcard-effort")
  })

  test("11. Real provider/model ID wins when exists predicate returns true", () => {
    const aliases: ModelAlias.Aliases = {
      providers: {
        openai: "google",
      },
      models: {
        "openai/gpt-4o": "google/gemini-2.5-flash",
      },
    }

    const exists = ({ providerID, modelID }: { providerID: string; modelID: string }) =>
      providerID === "openai" && modelID === "gpt-4o"

    // When exists is true, alias is not applied
    expect(ModelAlias.resolve(aliases, "openai/gpt-4o", exists)).toBe("openai/gpt-4o")

    // When exists is false, alias is applied
    expect(ModelAlias.resolve(aliases, "openai/gpt-4o", () => false)).toBe("google/gemini-2.5-flash")
  })

  test("12. Cycle detection throws AliasCycleError", () => {
    const cyclicAliases: ModelAlias.Aliases = {
      models: {
        a: "b",
        b: "c",
        c: "a",
      },
    }

    expect(() => ModelAlias.resolve(cyclicAliases, "a")).toThrow(AliasCycleError)
  })

  test("13. Chained alias expansion works without cycle", () => {
    const chainAliases: ModelAlias.Aliases = {
      providers: {
        p1: "p2",
        p2: "final-provider",
      },
      models: {
        alias1: "p1/alias-model",
        "final-provider/alias-model": "real-model#hi",
      },
      variants: {
        hi: "ultra",
      },
    }

    const resolved = ModelAlias.resolve(chainAliases, "alias1")
    expect(resolved).toBe("final-provider/real-model#ultra")
  })

  test("14. Real variant passes through when not aliased", () => {
    const resolved = ModelAlias.resolve(sampleAliases, "ds/deepseek-chat#unaliased-variant")
    expect(resolved).toBe("deepseek/deepseek-chat#unaliased-variant")
  })

  test("15. Empty variant is rejected on the alias path, as on the no-alias path", () => {
    expect(() => ModelAlias.resolve(sampleAliases, "openai/gpt-4o#")).toThrow("Invalid model reference: openai/gpt-4o#")
  })

  test("16. Variant containing a second # is rejected on the alias path", () => {
    expect(() => ModelAlias.resolve(sampleAliases, "openai/gpt-4o#high#extra")).toThrow(
      "Invalid model reference: openai/gpt-4o#high#extra",
    )
  })

  test("17. Invalid variants arriving via an alias target are rejected", () => {
    const emptyTarget: ModelAlias.Aliases = { models: { bad: "openai/gpt-4o#" } }
    expect(() => ModelAlias.resolve(emptyTarget, "bad")).toThrow("Invalid model reference: openai/gpt-4o#")
    const doubleHashTarget: ModelAlias.Aliases = { models: { bad: "openai/gpt-4o#a#b" } }
    expect(() => ModelAlias.resolve(doubleHashTarget, "bad")).toThrow("Invalid model reference: openai/gpt-4o#a#b")
  })

  test("18. A chain that settles exactly at the depth limit resolves", () => {
    const models: Record<string, string> = {}
    for (let i = 0; i < 9; i++) models[`a${i}`] = i === 8 ? "openai/gpt-4o" : `a${i + 1}`
    expect(ModelAlias.resolve({ models }, "a0")).toBe("openai/gpt-4o")
  })

  test("19. A chain one hop past the depth limit throws AliasMaxDepthError", () => {
    const models: Record<string, string> = {}
    for (let i = 0; i < 10; i++) models[`a${i}`] = i === 9 ? "openai/gpt-4o" : `a${i + 1}`
    expect(() => ModelAlias.resolve({ models }, "a0")).toThrow(AliasMaxDepthError)
  })
})
