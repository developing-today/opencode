import { describe, expect, test } from "bun:test"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"

const document = (info: ConstructorParameters<typeof Info>[0]) => new Document({ type: "document", info: new Info(info) })

describe("Config.changedSections", () => {
  test("reports nothing for equal entries", () => {
    const entries = [document({ shell: "zsh", default_agent: "build" })]

    expect(Config.changedSections(entries, [document({ shell: "zsh", default_agent: "build" })])).toEqual([])
  })

  test("reports only the top-level keys whose values differ", () => {
    const before = [document({ shell: "zsh", default_agent: "build" })]
    const after = [document({ shell: "fish", default_agent: "build" })]

    expect(Config.changedSections(before, after)).toEqual(["shell"])
  })

  test("reports a key that is added or removed", () => {
    const before = [document({ shell: "zsh" })]
    const after = [document({ shell: "zsh", default_agent: "plan" })]

    expect(Config.changedSections(before, after)).toEqual(["default_agent"])
    expect(Config.changedSections(after, before)).toEqual(["default_agent"])
  })

  test("compares documents in order, so a reordered layer counts as a change", () => {
    const low = document({ shell: "bash" })
    const high = document({ shell: "zsh" })

    expect(Config.changedSections([low, high], [high, low])).toEqual(["shell"])
  })
})
