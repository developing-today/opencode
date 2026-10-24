import { NodeServices } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Command } from "effect/cli"
import { Commands } from "../src/commands/commands"
import { list, time } from "../src/commands/handlers/msg/shared"

test("msg read parses repeatable topics and as", async () => {
  const received: unknown[] = []
  const command = Commands.commands.msg.commands.read.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => void received.push({ topics: list(input.topic), as: input.as, unread: input.unread })),
    ),
  )
  await Effect.runPromise(
    Command.runWith(command, { version: "test" })(["--topic", "a,b", "--topic", "c", "--unread", "--as", "ses_1"]).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )
  expect(received).toEqual([{ topics: ["a", "b", "c"], as: Option.some("ses_1"), unread: true }])
})

test("session chain parses its flags", async () => {
  const received: unknown[] = []
  const command = Commands.commands.session.commands.chain.spec.pipe(
    Command.withHandler((input) =>
      Effect.sync(() => void received.push([input.sessionID, input.all, input.full, input.format])),
    ),
  )
  await Effect.runPromise(
    Command.runWith(command, { version: "test" })(["--all", "--format", "json", "ses_1"]).pipe(
      Effect.provide(NodeServices.layer),
    ),
  )
  expect(received).toEqual([["ses_1", true, false, "json"]])
})

test("time formats local minutes and tolerates non-finite values", () => {
  expect(time(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04")
  expect(time("NaN")).toBe("-")
})
