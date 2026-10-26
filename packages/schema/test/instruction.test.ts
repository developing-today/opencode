import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Instruction } from "../src/instruction.js"
import { InstructionEntry } from "../src/instruction-entry.js"

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

describe("InstructionEntry.Key (#504)", () => {
  const decode = Schema.decodeUnknownSync(InstructionEntry.Key)
  const decodeDerived = Schema.decodeUnknownSync(Instruction.Key)

  test("accepts entry keys whose derived api/<key> is a valid Instruction.Key", () => {
    for (const input of ["a", "foo", "foo.bar", "foo_bar", "foo-bar", "f0o.b_ar-1"])
      expect(String(decodeDerived(`api/${String(decode(input))}`))).toBe(`api/${input}`)
  })

  test("rejects trailing-dot keys the derived Instruction.Key rejects", () => {
    for (const input of ["foo.", "foo..", "a.", "foo.bar."]) expect(() => decode(input)).toThrow(Schema.SchemaError)
  })
})
