import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Instruction } from "../src/instruction.js"

describe("Instruction.Key", () => {
  const decode = Schema.decodeUnknownSync(Instruction.Key)

  test("accepts the in-tree keys and multi-segment tails (#472)", () => {
    for (const input of ["core/date", "core/environment", "core/codemode", "api/foo", "test/context", "a/b/c"])
      expect(String(decode(input))).toBe(input)
  })

  test("rejects empty, dot and trailing-dot segments and trailing slashes (#472)", () => {
    for (const input of ["a/b/", "a/b//c", "a//b", "a/b/.", "a/b/..", "a/b..", "a./b", "a/b/c.", "a/.hidden/x"])
      expect(() => decode(input)).toThrow(Schema.SchemaError)
  })
})
