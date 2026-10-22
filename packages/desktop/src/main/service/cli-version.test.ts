import { describe, expect, test } from "bun:test"

import { parseCliVersion } from "./cli-version"

describe("parseCliVersion", () => {
  test.each([
    { name: "bare version", output: "2.1.0", expected: "2.1.0" },
    { name: "prefixed version", output: "opencode v2.1.0", expected: "2.1.0" },
    { name: "prerelease version", output: "opencode v2.1.0-beta.1", expected: "2.1.0-beta.1" },
    { name: "local version", output: "local", expected: "local" },
    {
      name: "diagnostic line after the version is not read as the version",
      output: "opencode v2.1.0\nWarning: something v9.9.9",
      expected: "2.1.0",
    },
    {
      name: "version line after a non-version line is recovered",
      output: "Warning: config v1 deprecated\n2.1.0",
      expected: "2.1.0",
    },
    {
      name: "trailing diagnostic line does not contaminate the version",
      output: "2.1.0\nextra diagnostic line",
      expected: "2.1.0",
    },
  ])("returns the CLI version for $name", (input) => {
    expect(parseCliVersion(input.output)).toBe(input.expected)
  })

  test.each([
    { name: "empty output", output: "" },
    { name: "whitespace only", output: "  \n" },
    { name: "shape-invalid output", output: "not-a-version!!" },
    { name: "version-shaped token inside a sentence only", output: "Warning: config v1 deprecated" },
  ])("throws for $name", (input) => {
    expect(() => parseCliVersion(input.output)).toThrow("V2 CLI did not provide a version")
  })
})
