import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { formatMessages, json, list, print, report, request } from "./shared"

const handler = Effect.fn("cli.msg.read")(function* (input: Runtime.Input<typeof Commands.commands.msg.commands.read>) {
  const result = yield* request(input, (client, signal) =>
    client.messaging.query(
      {
        as: Option.getOrUndefined(input.as),
        topics: list(input.topic),
        unread: input.unread || undefined,
        limit: Option.getOrUndefined(input.limit),
      },
      { signal },
    ),
  )
  if (input.format === "json") return print(json(result))
  print([formatMessages(result.messages), result.note ?? ""].filter(Boolean).join("\n"))
})

export default Runtime.handler(Commands.commands.msg.commands.read, (input) => report(handler(input)))
