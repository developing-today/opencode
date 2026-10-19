import { describe, expect, test } from "bun:test"
import { isLeaked, isTempHome, parseEnv, parsePsEnv } from "./mcpx-cleanup"

describe("isTempHome", () => {
  test("detects a Linux temp home", () => {
    expect(isTempHome("/tmp/opencode-test-abc", "/tmp")).toBe(true)
    expect(isTempHome("/tmp", "/tmp")).toBe(true)
  })

  test("detects a macOS temp home when tmpdir() ends in a separator", () => {
    expect(isTempHome("/var/folders/xy/T/opencode-test-abc", "/var/folders/xy/T/")).toBe(true)
    expect(isTempHome("/var/folders/xy/T", "/var/folders/xy/T/")).toBe(true)
  })

  test("detects a Windows temp home with backslash separators", () => {
    expect(
      isTempHome("C:\\Users\\u\\AppData\\Local\\Temp\\opencode-test-abc", "C:\\Users\\u\\AppData\\Local\\Temp"),
    ).toBe(true)
    expect(
      isTempHome("c:\\users\\u\\appdata\\local\\temp\\opencode-test-abc", "C:\\Users\\u\\AppData\\Local\\Temp\\"),
    ).toBe(true)
  })

  test("does not match a sibling directory that shares a prefix", () => {
    expect(isTempHome("/tmpfoo/opencode-test-abc", "/tmp")).toBe(false)
    expect(isTempHome("C:\\TempOther\\opencode-test-abc", "C:\\Temp")).toBe(false)
  })

  test("never treats a real home as a temp home", () => {
    expect(isTempHome("/home/user", "/tmp")).toBe(false)
    expect(isTempHome("/Users/user", "/var/folders/xy/T/")).toBe(false)
    expect(isTempHome("C:\\Users\\user", "C:\\Users\\u\\AppData\\Local\\Temp")).toBe(false)
  })
})

describe("isLeaked", () => {
  const exists = () => true
  const missing = () => false

  test("a live temp home is leaked on every platform shape", () => {
    expect(isLeaked("/tmp/opencode-test-abc", "/tmp", exists)).toBe(true)
    expect(isLeaked("/var/folders/xy/T/opencode-test-abc", "/var/folders/xy/T/", exists)).toBe(true)
    expect(
      isLeaked("C:\\Users\\u\\AppData\\Local\\Temp\\opencode-test-abc", "C:\\Users\\u\\AppData\\Local\\Temp", exists),
    ).toBe(true)
  })

  test("a missing home is leaked", () => {
    expect(isLeaked("/home/gone", "/tmp", missing)).toBe(true)
  })

  test("a real home that still exists is never leaked", () => {
    expect(isLeaked("/home/user", "/tmp", exists)).toBe(false)
  })

  test("a daemon without a home is never leaked", () => {
    expect(isLeaked(undefined, "/tmp", missing)).toBe(false)
  })
})

describe("parsePsEnv", () => {
  test("keeps a HOME value containing spaces intact", () => {
    const raw =
      "  123 ??  Ss     0:00 /usr/local/bin/mcpx daemon HOME=/Users/John Smith/.home MCPX_OWNER=opencode:42 PATH=/usr/bin:/bin"
    const env = parsePsEnv(raw)
    expect(env.get("HOME")).toBe("/Users/John Smith/.home")
    expect(env.get("MCPX_OWNER")).toBe("opencode:42")
    expect(env.get("PATH")).toBe("/usr/bin:/bin")
  })

  test("parses plain entries", () => {
    const env = parsePsEnv("HOME=/home/user MCPX_OWNER=opencode:7")
    expect(env.get("HOME")).toBe("/home/user")
    expect(env.get("MCPX_OWNER")).toBe("opencode:7")
  })
})

describe("parseEnv", () => {
  test("splits Linux environ on NUL and keeps spaces in values", () => {
    const env = parseEnv("HOME=/home/John Smith\0MCPX_OWNER=opencode:1\0", "linux")
    expect(env.get("HOME")).toBe("/home/John Smith")
    expect(env.get("MCPX_OWNER")).toBe("opencode:1")
  })
})
