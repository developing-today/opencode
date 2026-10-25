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

  test("20. Variant alias target containing # is rejected (bare and scoped keys)", () => {
    const bare: ModelAlias.Aliases = { variants: { hi: "high#extra" } }
    expect(() => ModelAlias.resolve(bare, "openai/gpt-4o#hi")).toThrow(
      "Invalid model reference: openai/gpt-4o#high#extra",
    )
    const scoped: ModelAlias.Aliases = { variants: { "deepseek/*#hi": "high#extra" } }
    expect(() => ModelAlias.resolve(scoped, "deepseek/other-model#hi")).toThrow(
      "Invalid model reference: deepseek/other-model#high#extra",
    )
    const hashOnly: ModelAlias.Aliases = { variants: { hi: "#" } }
    expect(() => ModelAlias.resolve(hashOnly, "openai/gpt-4o#hi")).toThrow("Invalid model reference: openai/gpt-4o##")
  })

  test("21. Empty variant alias target is rejected (bare and wildcard keys)", () => {
    const bare: ModelAlias.Aliases = { variants: { hi: "" } }
    expect(() => ModelAlias.resolve(bare, "openai/gpt-4o#hi")).toThrow("Invalid model reference: openai/gpt-4o#")
    const wildcard: ModelAlias.Aliases = { variants: { "*/*#hi": "" } }
    expect(() => ModelAlias.resolve(wildcard, "openai/gpt-4o#hi")).toThrow("Invalid model reference: openai/gpt-4o#")
  })

  test("22. Provider alias target containing / is rejected instead of reshaping the ref", () => {
    const aliases: ModelAlias.Aliases = { providers: { x: "a/b" } }
    expect(() => ModelAlias.resolve(aliases, "x/model")).toThrow("Invalid model reference: x/model")
  })

  test("23. Provider alias target containing # or empty is rejected", () => {
    const hashTarget: ModelAlias.Aliases = { providers: { x: "a#b" } }
    expect(() => ModelAlias.resolve(hashTarget, "x/model")).toThrow("Invalid model reference: x/model")
    const emptyTarget: ModelAlias.Aliases = { providers: { x: "" } }
    expect(() => ModelAlias.resolve(emptyTarget, "x/model")).toThrow("Invalid model reference: x/model")
  })
  test("24. Empty model alias target is rejected (global, original-provider scoped, and resolved-provider scoped)", () => {
    const global: ModelAlias.Aliases = { models: { bad: "" } }
    expect(() => ModelAlias.resolve(global, "bad")).toThrow("Invalid model reference: bad")
    const original: ModelAlias.Aliases = { models: { "openai/pro": "" } }
    expect(() => ModelAlias.resolve(original, "openai/pro")).toThrow("Invalid model reference: openai/pro")
    const viaOriginalKey: ModelAlias.Aliases = { providers: { ds: "deepseek" }, models: { "ds/pro": "" } }
    expect(() => ModelAlias.resolve(viaOriginalKey, "ds/pro")).toThrow("Invalid model reference: ds/pro")
    const viaResolvedKey: ModelAlias.Aliases = { providers: { ds: "deepseek" }, models: { "deepseek/pro": "" } }
    expect(() => ModelAlias.resolve(viaResolvedKey, "ds/pro")).toThrow("Invalid model reference: ds/pro")
  })

  test("25. Prototype member names are not aliases when not configured (#414)", () => {
    const models: ModelAlias.Aliases = { models: { other: "openai/gpt-4o" } }
    expect(() => ModelAlias.resolve(models, "toString")).toThrow(
      "Invalid model reference after alias resolution: toString",
    )
    expect(() => ModelAlias.resolve(models, "constructor")).toThrow(
      "Invalid model reference after alias resolution: constructor",
    )
    const providers: ModelAlias.Aliases = { providers: { other: "openai" } }
    expect(ModelAlias.resolve(providers, "toString/model")).toBe("toString/model")
    expect(ModelAlias.resolve(providers, "hasOwnProperty/model")).toBe("hasOwnProperty/model")
    const variants: ModelAlias.Aliases = { variants: { hi: "high" } }
    expect(ModelAlias.resolve(variants, "openai/gpt-4o#toString")).toBe("openai/gpt-4o#toString")
    expect(ModelAlias.resolve(variants, "openai/gpt-4o#constructor")).toBe("openai/gpt-4o#constructor")
    expect(ModelAlias.resolve(variants, "openai/gpt-4o#__proto__")).toBe("openai/gpt-4o#__proto__")
  })

  test("26. A configured alias named like a prototype member still resolves (#414)", () => {
    expect(ModelAlias.resolve({ models: { toString: "openai/gpt-4o" } }, "toString")).toBe("openai/gpt-4o")
    expect(ModelAlias.resolve({ providers: { toString: "openai" } }, "toString/model")).toBe("openai/model")
    expect(ModelAlias.resolve({ variants: { constructor: "high" } }, "openai/gpt-4o#constructor")).toBe(
      "openai/gpt-4o#high",
    )
  })

  test("27. Whitespace-only or padded alias targets are rejected (#412)", () => {
    const provider: ModelAlias.Aliases = { providers: { x: " " } }
    expect(() => ModelAlias.resolve(provider, "x/model")).toThrow("Invalid model reference: x/model")
    const paddedProvider: ModelAlias.Aliases = { providers: { x: " openai" } }
    expect(() => ModelAlias.resolve(paddedProvider, "x/model")).toThrow("Invalid model reference: x/model")
    const scoped: ModelAlias.Aliases = { models: { "openai/pro": " " } }
    expect(() => ModelAlias.resolve(scoped, "openai/pro")).toThrow("Invalid model reference: openai/pro")
    const viaResolved: ModelAlias.Aliases = { providers: { ds: "deepseek" }, models: { "deepseek/pro": " " } }
    expect(() => ModelAlias.resolve(viaResolved, "ds/pro")).toThrow("Invalid model reference: ds/pro")
    const global: ModelAlias.Aliases = { models: { bad: "openai/gpt-4o " } }
    expect(() => ModelAlias.resolve(global, "bad")).toThrow("Invalid model reference: bad")
    const paddedSegment: ModelAlias.Aliases = { models: { bad: "openai /gpt-4o" } }
    expect(() => ModelAlias.resolve(paddedSegment, "bad")).toThrow("Invalid model reference: bad")
  })

  test("29. Bare scoped alias target whose variant contains a / resolves under its provider (#422)", () => {
    const original: ModelAlias.Aliases = { models: { "openai/old": "new#va/r" } }
    expect(ModelAlias.resolve(original, "openai/old")).toBe("openai/new#va/r")
    const viaResolved: ModelAlias.Aliases = {
      providers: { ds: "openai" },
      models: { "openai/old": "new#va/r" },
    }
    expect(ModelAlias.resolve(viaResolved, "ds/old")).toBe("openai/new#va/r")
    const slashForm: ModelAlias.Aliases = { models: { "openai/old": "other/new#va/r" } }
    expect(ModelAlias.resolve(slashForm, "openai/old")).toBe("other/new#va/r")
  })

  test("28. Whitespace-only or padded variant alias targets are rejected (#412)", () => {
    const bare: ModelAlias.Aliases = { variants: { hi: " " } }
    expect(() => ModelAlias.resolve(bare, "openai/gpt-4o#hi")).toThrow("Invalid model reference: openai/gpt-4o# ")
    const tab: ModelAlias.Aliases = { variants: { hi: "\t" } }
    expect(() => ModelAlias.resolve(tab, "openai/gpt-4o#hi")).toThrow("Invalid model reference: openai/gpt-4o#\t")
    const scoped: ModelAlias.Aliases = { variants: { "deepseek/*#hi": " max" } }
    expect(() => ModelAlias.resolve(scoped, "deepseek/other#hi")).toThrow(
      "Invalid model reference: deepseek/other# max",
    )
  })
})
