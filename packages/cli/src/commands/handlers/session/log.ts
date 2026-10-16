import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { json, list, oneLine, print, report, request, time } from "../msg/shared"

const parts = [
  "user",
  "output",
  "thinking",
  "tools",
  "results",
  "system",
  "synthetic",
  "shell",
  "events",
  "compaction",
] as const

const handler = Effect.fn("cli.session.log")(function* (
  input: Runtime.Input<typeof Commands.commands.session.commands.log>,
) {
  const values = list(input.include) ?? []
  const include = values.flatMap((value) => parts.filter((part) => part === value))
  const unknown = values.filter((value) => !include.some((part) => part === value))
  if (unknown.length)
    return yield* Effect.fail(new Error(`Unknown log part: ${unknown.join(", ")}. Expected: ${parts.join(", ")}`))
  const result = yield* request(input, (client, signal) =>
    client.messaging.log(
      {
        sessions: [input.sessionID],
        op: Option.getOrUndefined(input.op),
        query: Option.getOrUndefined(input.query),
        include: include.length ? include : undefined,
        limit: Option.getOrUndefined(input.limit),
      },
      { signal },
    ),
  )
  if (input.format === "json") return print(json(result))
  print(
    [
      // Context entries around grep matches are indented so matches stand out.
      ...result.entries.map((entry) =>
        [
          `${entry.match === false ? "  " : ""}${entry.index}`,
          time(entry.time),
          entry.tool ? `${entry.part}:${entry.tool}` : entry.part,
          oneLine(entry.text),
        ].join("  "),
      ),
      ...(result.more ? [`(${result.entries.length} of ${result.total} shown)`] : []),
      ...(result.note ? [result.note] : []),
    ].join("\n"),
  )
})

export default Runtime.handler(Commands.commands.session.commands.log, (input) => report(handler(input)))
