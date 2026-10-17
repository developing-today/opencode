import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { formatMessages, json, list, print, report, request } from "./shared"

const handler = Effect.fn("cli.msg.search")(function* (
  input: Runtime.Input<typeof Commands.commands.msg.commands.search>,
) {
  const result = yield* request(input, (client, signal) =>
    client.messaging.query(
      {
        query: input.query,
        topics: list(input.topic),
        match: Option.getOrUndefined(input.match),
        limit: Option.getOrUndefined(input.limit),
      },
      { signal },
    ),
  )
  if (input.format === "json") return print(json(result))
  print(
    [formatMessages(result.messages), result.match ? `match: ${result.match}` : "", result.note ?? ""]
      .filter(Boolean)
      .join("\n"),
  )
})

export default Runtime.handler(Commands.commands.msg.commands.search, (input) => report(handler(input)))
