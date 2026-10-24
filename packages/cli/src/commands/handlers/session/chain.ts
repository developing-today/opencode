import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { json, print, report, request, time } from "../msg/shared"

const handler = Effect.fn("cli.session.chain")(function* (
  input: Runtime.Input<typeof Commands.commands.session.commands.chain>,
) {
  const result = yield* request(input, (client, signal) =>
    client.messaging.chain(
      { session: input.sessionID, depth: input.all ? "all" : "parent", detail: input.full ? "full" : "brief" },
      { signal },
    ),
  )
  if (input.format === "json") return print(json(result))
  print(
    result.chain
      .map((node) =>
        [
          node.id,
          `depth ${node.depth}`,
          node.status,
          ...(node.agent ? [node.agent] : []),
          ...(node.model ? [node.model] : []),
          time(node.updated ?? node.created),
          (node.title ?? "Untitled session").replace(/[\r\n\t]/g, " "),
          ...(input.full ? [node.directory] : []),
          ...(node.children === undefined ? [] : [`${node.children} children`]),
          ...(node.messages === undefined ? [] : [`${node.messages} msgs`]),
        ].join("  "),
      )
      .join("\n"),
  )
})

export default Runtime.handler(Commands.commands.session.commands.chain, (input) => report(handler(input)))
