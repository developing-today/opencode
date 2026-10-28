import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { MessagingTemplate } from "@opencode/core/messaging/template"

const failure = async (template: string, vars: Record<string, string>) => {
  const exit = await Effect.runPromiseExit(
    MessagingTemplate.render(
      template,
      (name) => Effect.succeed(vars[name] === undefined ? undefined : { value: vars[name], template: true }),
      { strict: true },
    ),
  )
  if (exit._tag === "Success") return ""
  const error = Cause.squash(exit.cause)
  return error instanceof Error ? error.message : String(error)
}

const rendered = (template: string, vars: Record<string, string>) =>
  Effect.runPromise(
    MessagingTemplate.render(
      template,
      (name) => Effect.succeed(vars[name] === undefined ? undefined : { value: vars[name], template: true }),
      { strict: true },
    ),
  )

/** v1 -> v2 -> ... -> v<count> -> "done": an acyclic chain of `count` template variables. */
const chain = (count: number) => {
  const vars: Record<string, string> = {}
  for (let index = 1; index < count; index++) vars[`v${index}`] = `{v${index + 1}}`
  vars[`v${count}`] = "done"
  return vars
}

describe("MessagingTemplate.render expansion limits", () => {
  test("a direct self-reference reports a cycle", async () => {
    const error = await failure("{x}", { x: "{x}" })
    expect(error).toContain("cycle")
    expect(error).toContain("{x}")
  })

  test("an indirect cycle reports a cycle, naming the loop", async () => {
    const error = await failure("{x}", { x: "{y}", y: "{x}" })
    expect(error).toContain("cycle")
    expect(error).toContain("x -> y -> x")
  })

  test("an acyclic chain past the depth limit reports the depth limit, not a cycle", async () => {
    const error = await failure("{v1}", chain(11))
    expect(error).toContain("depth")
    expect(error).toContain("8")
    expect(error).not.toContain("refers to itself")
    expect(error).not.toContain("cycle")
  })

  test("a chain at exactly the depth limit still renders", async () => {
    await expect(rendered("{v1}", chain(8))).resolves.toBe("done")
  })
})

describe("MessagingTemplate.parseTime bare epochs", () => {
  const now = Date.parse("2026-10-27T00:00:00Z")

  test("a 10-digit epoch-seconds value is scaled to milliseconds", () => {
    expect(MessagingTemplate.parseTime("1767225600", now)).toBe(1767225600000)
  })

  test("a 13-digit epoch-milliseconds value is read as-is and agrees with the seconds form", () => {
    expect(MessagingTemplate.parseTime("1767225600000", now)).toBe(1767225600000)
    expect(MessagingTemplate.parseTime("1767225600000", now)).toBe(MessagingTemplate.parseTime("1767225600", now))
  })

  test("other bare-digit lengths are rejected instead of silently misread", () => {
    expect(MessagingTemplate.parseTime("999999999", now)).toBeUndefined()
    expect(MessagingTemplate.parseTime("17672256000", now)).toBeUndefined()
    expect(MessagingTemplate.parseTime("17672256000000", now)).toBeUndefined()
  })

  test("calendar-invalid ISO dates are rejected instead of rolling into the next month", () => {
    expect(MessagingTemplate.parseTime("2026-02-30", now)).toBeUndefined()
    expect(MessagingTemplate.parseTime("2026-02-29", now)).toBeUndefined()
    expect(MessagingTemplate.parseTime("2026-04-31", now)).toBeUndefined()
    expect(MessagingTemplate.parseTime("2025-02-29T00:00:00Z", now)).toBeUndefined()
    expect(MessagingTemplate.parseTime("2026-13-01", now)).toBeUndefined()
  })

  test("leap-valid and offset ISO forms still parse, and non-ISO forms keep Date.parse behaviour", () => {
    expect(MessagingTemplate.parseTime("2024-02-29", now)).toBe(Date.parse("2024-02-29"))
    expect(MessagingTemplate.parseTime("2026-01-01T00:00:00+05:00", now)).toBe(Date.parse("2026-01-01T00:00:00+05:00"))
    expect(MessagingTemplate.parseTime("Jan 5 2026", now)).toBe(Date.parse("Jan 5 2026"))
  })

  test("ISO and relative forms still parse", () => {
    expect(MessagingTemplate.parseTime("2026-01-01T00:00:00Z", now)).toBe(1767225600000)
    expect(MessagingTemplate.parseTime("2h", now)).toBe(now - 2 * 3_600_000)
  })
})
