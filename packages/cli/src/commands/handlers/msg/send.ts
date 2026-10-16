import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { print, report, request } from "./shared"

const handler = Effect.fn("cli.msg.send")(function* (input: Runtime.Input<typeof Commands.commands.msg.commands.send>) {
  const result = yield* request(input, (client, signal) =>
    client.messaging.send(
      {
        text: input.text,
        to: Option.getOrUndefined(input.to),
        topic: Option.getOrUndefined(input.topic),
        type: Option.getOrUndefined(input.type),
        deliver: Option.getOrUndefined(input.deliver),
        force: input.force || undefined,
      },
      { signal },
    ),
  )
  print(
    [
      `Sent ${result.topic}#${result.seq}${result.forced ? " (forced)" : ""}`,
      ...result.delivered.map((item) => `  delivered to ${item.session} (${item.delivery})`),
    ].join("\n"),
  )
})

export default Runtime.handler(Commands.commands.msg.commands.send, (input) => report(handler(input)))
