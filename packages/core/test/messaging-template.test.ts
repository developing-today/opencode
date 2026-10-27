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
