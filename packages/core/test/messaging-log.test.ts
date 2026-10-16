import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { MessagingLog } from "@opencode/core/messaging/log"
import { SessionMessage } from "@opencode/core/session/message"

const decode = Schema.decodeUnknownSync(Schema.Array(SessionMessage.Info))

const messages = decode([
  { id: "msg_1", type: "user", time: { created: 1_000 }, text: "Please fix the parser" },
  {
    id: "msg_2",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    time: { created: 2_000 },
    content: [
      { type: "reasoning", text: "The tokenizer drops the last token", time: { created: 2_000 } },
      { type: "text", text: "Fixed the off-by-one in the tokenizer." },
      {
        type: "tool",
        id: "call_1",
        name: "edit",
        state: {
          status: "completed",
          input: { path: "parser.ts" },
          content: [{ type: "text", text: "Edited parser.ts" }],
        },
        time: { created: 2_000 },
      },
    ],
  },
  { id: "msg_3", type: "system", time: { created: 3_000 }, text: "The instructions changed" },
  {
    id: "msg_4",
    type: "synthetic",
    time: { created: 4_000 },
    text: '<message topic="ses_a/bidi/ses_b" seq="1" from="ses_b" time="x">\nAre the tests green?\n</message>',
    description: "✉ Worker → ses_a/bidi/ses_b: Are the tests green?",
    metadata: { source: "messaging", from: "ses_b", topic: "ses_a/bidi/ses_b" },
  },
  { id: "msg_5", type: "idle", time: { created: 5_000 }, outcome: "succeeded" },
])

const parts = (included: ReadonlyArray<MessagingLog.Entry["part"]>) =>
  MessagingLog.entries("ses_a", messages, new Set(included)).map((entry) => [entry.part, entry.text, entry.label])

describe("MessagingLog.entries", () => {
  test("splits a transcript into parts that can be included or left out", () => {
    expect(parts(MessagingLog.defaultParts)).toEqual([
      ["user", "Please fix the parser", undefined],
      ["output", "Fixed the off-by-one in the tokenizer.", undefined],
      ["tools", 'edit({"path":"parser.ts"}) → completed', undefined],
      ["synthetic", "Are the tests green?", "✉ ses_b → ses_a/bidi/ses_b"],
    ])
    expect(parts(["thinking", "results", "system", "events"])).toEqual([
      ["thinking", "The tokenizer drops the last token", undefined],
      ["results", "Edited parser.ts", undefined],
      ["system", "The instructions changed", undefined],
      ["events", "[idle: succeeded]", undefined],
    ])
  })

  test("clips long entries around an omission marker", () => {
    const clipped = MessagingLog.clip("a".repeat(500) + "b".repeat(500), 100)
    expect(clipped.length).toBeLessThan(140)
    expect(clipped.startsWith("a".repeat(70))).toBe(true)
    expect(clipped.endsWith("b".repeat(10))).toBe(true)
    expect(clipped).toContain("chars]")
  })
})
