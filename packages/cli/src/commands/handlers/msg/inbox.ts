import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { formatMessages, json, print, report, request } from "./shared"

const handler = Effect.fn("cli.msg.inbox")(function* (
  input: Runtime.Input<typeof Commands.commands.msg.commands.inbox>,
) {
  // Query newest first so the limit keeps the latest messages, then print newest last.
  const result = yield* request(input, (client, signal) =>
    client.messaging.query({ types: ["user"], order: "desc", limit: Option.getOrUndefined(input.limit) }, { signal }),
  )
  const messages = result.messages.toReversed()
  if (input.format === "json") return print(json({ ...result, messages }))
  print(formatMessages(messages))
})

export default Runtime.handler(Commands.commands.msg.commands.inbox, (input) => report(handler(input)))
