import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { json, oneLine, print, report, request, time } from "./shared"

const handler = Effect.fn("cli.msg.topics")(function* (
  input: Runtime.Input<typeof Commands.commands.msg.commands.topics>,
) {
  const result = yield* request(input, (client, signal) =>
    client.messaging.topics(
      {
        sessions: Option.match(input.session, { onNone: () => undefined, onSome: (session) => [session] }),
        limit: Option.getOrUndefined(input.limit),
      },
      { signal },
    ),
  )
  if (input.format === "json") return print(json(result))
  print(
    result.topics
      .map((topic) =>
        [
          topic.name,
          topic.kind,
          topic.mode,
          `${topic.messages} msgs`,
          ...(topic.unread ? [`${topic.unread} unread`] : []),
          time(topic.last),
          ...(topic.description ? [oneLine(topic.description)] : []),
        ].join("  "),
      )
      .join("\n"),
  )
})

export default Runtime.handler(Commands.commands.msg.commands.topics, (input) => report(handler(input)))
