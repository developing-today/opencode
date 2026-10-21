import { describe, expect, test } from "bun:test"
import { parsePortEnv } from "../src/restart-port"

describe("parsePortEnv", () => {
  test.each([
    // [OC_PORT, expected port, warning/invalid expected]
    [undefined, 4096, false],
    ["4097", 4097, false],
    ["4096", 4096, false],
    ["1", 1, false],
    ["65535", 65535, false],
    [" 4097 ", 4097, false],
    ["abc", 4096, true],
    ["4096.9", 4096, true],
    ["99999", 4096, true],
    ["65536", 4096, true],
    ["", 4096, true],
    ["0x10", 4096, true],
    ["0", 4096, true],
    ["+4096", 4096, true],
  ])("OC_PORT=%p -> port %i, invalid %p", (value, port, invalid) => {
    expect(parsePortEnv(value as string | undefined)).toEqual({ port, invalid })
  })
})
