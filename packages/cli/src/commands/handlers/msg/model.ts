import { Effect, Option } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { json, print, report, request } from "./shared"

const handler = Effect.fn("cli.msg.model")(function* (
  input: Runtime.Input<typeof Commands.commands.msg.commands.model>,
) {
  const tier = Option.getOrUndefined(input.tier)
  // configure returns the resulting status, so it doubles as the status read.
  const status = yield* request(input, (client, signal) =>
    tier || input.start
      ? client.messaging.model.configure({ tier, start: input.start || undefined }, { signal })
      : client.messaging.model.status({ signal }),
  )
  if (input.format === "json") return print(json(status))
  print(
    [
      `state: ${status.state}`,
      ...(status.tier ? [`tier: ${status.tier}`] : []),
      ...(status.model ? [`model: ${status.model}${status.dimensions ? ` (${status.dimensions} dims)` : ""}`] : []),
      ...(status.source ? [`source: ${status.source}`] : []),
      ...(status.endpoint ? [`endpoint: ${status.endpoint}${status.remote ? " (remote)" : ""}`] : []),
      ...(status.error ? [`error: ${status.error}`] : []),
      ...(status.indexed !== undefined || status.pending !== undefined
        ? [`indexed: ${status.indexed ?? 0}  pending: ${status.pending ?? 0}`]
        : []),
      ...(status.progress?.length ? ["progress:"] : []),
      ...(status.progress ?? []).map(
        (item) =>
          `  ${item.file}  ${item.total ? `${Math.floor((item.received / item.total) * 100)}%` : `${item.received} bytes`}`,
      ),
      ...(status.tiers?.length ? ["tiers:"] : []),
      ...(status.tiers ?? []).map((item) =>
        [
          `${item.name === status.tier ? "*" : " "} ${item.name}`,
          item.model,
          item.size,
          item.hardware,
          item.available ? "available" : "unavailable",
        ].join("  "),
      ),
    ].join("\n"),
  )
})

export default Runtime.handler(Commands.commands.msg.commands.model, (input) => report(handler(input)))
