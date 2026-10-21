import { describe, expect, test } from "bun:test"
import { join } from "node:path"

// Turbo's JSONC parser silently keeps the last definition when an object
// repeats a key, so a duplicated task in turbo.json reads as one thing and
// runs as another (#145). This scan is duplicate-aware: it walks the raw
// text, tracks the keys of every object, and reports any key an object
// defines twice. Comments and string contents never count as keys.
export function duplicateKeys(text: string) {
  const duplicates: string[] = []
  const stack: ({ object: true; keys: Set<string>; key: boolean } | { object: false })[] = []

  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index)
      index = end === -1 ? text.length : end
      continue
    }

    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index)
      index = end === -1 ? text.length : end + 2
      continue
    }

    if (char === '"') {
      let end = index + 1

      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end++
        end++
      }

      const frame = stack[stack.length - 1]

      if (frame?.object && frame.key) {
        const name = JSON.parse(text.slice(index, end + 1)) as string

        if (frame.keys.has(name)) duplicates.push(name)
        frame.keys.add(name)
        frame.key = false
      }

      index = end + 1
      continue
    }

    if (char === "{") stack.push({ object: true, keys: new Set(), key: true })
    if (char === "[") stack.push({ object: false })
    if (char === "}" || char === "]") stack.pop()
    if (char === ",") {
      const frame = stack[stack.length - 1]
      if (frame?.object) frame.key = true
    }

    index++
  }

  return duplicates
}

describe("turbo.json", () => {
  test("defines every key exactly once", async () => {
    const text = await Bun.file(join(import.meta.dir, "..", "turbo.json")).text()
    expect(duplicateKeys(text)).toEqual([])
  })

  test("the scan itself catches a repeated task key", () => {
    const text = `{ "tasks": { "@opencode/sdk#test": {}, "@opencode/sdk#test": {} } }`
    expect(duplicateKeys(text)).toEqual(["@opencode/sdk#test"])
  })

  test("the scan ignores comments and braces inside strings", () => {
    const text = `{ // "@opencode/sdk#test": {}\n "note": "{ not a key }", "tasks": {} }`
    expect(duplicateKeys(text)).toEqual([])
  })
})
