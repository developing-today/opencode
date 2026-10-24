import { describe, expect, test } from "bun:test"
import { deadVars, documentedVars } from "./check-doc-env-vars"

describe("documentedVars", () => {
  test("extracts distinct OPENCODE_* names, sorted", () => {
    const md = [
      "| `OPENCODE_ZULU` | boolean | last |",
      "Set `OPENCODE_ALPHA` and again `OPENCODE_ZULU`.",
      "Not a variable: OPENCODE has no suffix, and `NOT_OPENCODE_X` is a different name.",
    ].join("\n")
    expect(documentedVars(md)).toEqual(["OPENCODE_ALPHA", "OPENCODE_ZULU"])
  })

  test("returns an empty list when nothing is documented", () => {
    expect(documentedVars("no variables here")).toEqual([])
  })
})

describe("deadVars", () => {
  test("keeps only variables with no reader", () => {
    const readers = new Set(["OPENCODE_READ_SOMEWHERE"])
    expect(deadVars(["OPENCODE_READ_SOMEWHERE", "OPENCODE_READ_NOWHERE"], (name) => readers.has(name))).toEqual([
      "OPENCODE_READ_NOWHERE",
    ])
  })

  test("is empty when every variable has a reader", () => {
    expect(deadVars(["OPENCODE_READ_SOMEWHERE"], () => true)).toEqual([])
  })
})
