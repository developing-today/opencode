import { describe, expect, test } from "bun:test"
import { parseVersion } from "./remote-cli"

describe("WSL parseVersion", () => {
  test("returns a clean version line unchanged", () => {
    expect(parseVersion("2.1.0\n")).toBe("2.1.0")
    expect(parseVersion("opencode v2.1.0\n")).toBe("2.1.0")
    expect(parseVersion("local\n")).toBe("local")
  })

  test("skips a login-shell banner before the version line", () => {
    expect(parseVersion("Welcome to Ubuntu 24.04 LTS\n2.1.0\n")).toBe("2.1.0")
    expect(parseVersion("Last login: Thu Oct 22 00:01:02 2026 from 10.0.0.2\r\n2.1.0\r\n")).toBe("2.1.0")
  })

  test("does not read a version out of a banner line containing ' v'", () => {
    expect(parseVersion("dev tools v3 loaded\nopencode v2.1.0\n")).toBe("2.1.0")
  })

  test("returns null when no line is a version", () => {
    expect(parseVersion("")).toBeNull()
    expect(parseVersion("  \n\n")).toBeNull()
    expect(parseVersion("Welcome to Ubuntu 24.04 LTS\n")).toBeNull()
  })
})
