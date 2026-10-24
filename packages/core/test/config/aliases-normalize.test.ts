import { describe, expect, test } from "bun:test"
import { ConfigNormalize } from "@opencode/core/config/normalize"

describe("ConfigNormalize with Aliases", () => {
  test("resolves aliases in default model, agents, commands, and model_routes", () => {
    const rawConfig = {
      aliases: {
        providers: {
          ds: "deepseek",
          cf: "cloudflare-gateway",
        },
        models: {
          flash: "deepseek/deepseek-chat#high",
          "deepseek/pro": "deepseek-v4-pro",
        },
        variants: {
          hi: "high",
          "deepseek/*#hi": "max",
        },
      },
      model: "flash",
      agents: {
        coder: {
          model: "ds/pro#hi",
        },
      },
      commands: {
        review: {
          template: "Review code",
          model: "ds/deepseek-chat#hi",
        },
      },
      experimental: {
        model_routes: {
          "fast-pool": {
            targets: ["flash", "ds/pro"],
            selection: "ordered",
          },
        },
      },
    }

    const result = ConfigNormalize.normalize(rawConfig)
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return

    // 1. Default model resolved from "flash" -> providerID: "deepseek", model: "deepseek-chat", variant: "high"
    expect(result.encoded.model).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "high",
    })

    // 2. Agent model resolved from "ds/pro#hi" -> providerID: "deepseek", model: "deepseek-v4-pro", variant: "max" (deepseek/*#hi -> max)
    const agents = result.encoded.agents as Record<string, any>
    expect(agents.coder.model).toEqual({
      providerID: "deepseek",
      model: "deepseek-v4-pro",
      variant: "max",
    })

    // 3. Command model resolved from "ds/deepseek-chat#hi" -> providerID: "deepseek", model: "deepseek-chat", variant: "max"
    const commands = result.encoded.commands as Record<string, any>
    expect(commands.review.model).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "max",
    })

    // 4. Route targets resolved to structured model targets
    const experimental = result.encoded.experimental as Record<string, any>
    const targets = experimental.model_routes["fast-pool"].targets
    expect(targets[0]).toEqual({
      providerID: "deepseek",
      model: "deepseek-chat",
      variant: "high",
    })
    expect(targets[1]).toEqual({
      providerID: "deepseek",
      model: "deepseek-v4-pro",
    })

    // 5. Aliases preserved in encoded config
    expect(result.encoded.aliases).toEqual(rawConfig.aliases)
  })

  test("accepts aliases placed under experimental.aliases as well", () => {
    const rawConfig = {
      experimental: {
        aliases: {
          providers: {
            ds: "deepseek",
          },
          models: {
            fast: "ds/fast-model",
          },
        },
      },
      model: "fast",
    }

    const result = ConfigNormalize.normalize(rawConfig)
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return

    expect(result.encoded.model).toEqual({
      providerID: "deepseek",
      model: "fast-model",
    })
  })
})
