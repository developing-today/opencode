import { OpenCode, type MessagingMessage, type OpenCodeClient } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { ServerConnection } from "../../../services/server-connection"
import { errorMessage } from "../../../util/error"

export const request = Effect.fn("cli.msg.request")(function* <A>(
  input: { readonly server: Option.Option<string>; readonly standalone: boolean },
  call: (client: OpenCodeClient, signal: AbortSignal) => Promise<A>,
) {
  const server = yield* ServerConnection.resolve({
    server: Option.getOrUndefined(input.server),
    standalone: input.standalone,
  })
  const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  return yield* Effect.tryPromise({ try: (signal) => call(client, signal), catch: (cause) => cause })
})

export function report<E, R>(effect: Effect.Effect<void, E, R>) {
  return effect.pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        process.stderr.write(errorMessage(error) + EOL)
        process.exitCode = 1
      }),
    ),
  )
}

export function print(output: string) {
  if (output) process.stdout.write(output + EOL)
}

export function json(value: unknown) {
  return JSON.stringify(value, null, 2)
}

/** Split repeatable, comma separated flag values into a list, or undefined when empty. */
export function list(values: ReadonlyArray<string>) {
  const result = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
  return result.length ? result : undefined
}

/** Local `YYYY-MM-DD HH:MM`; the API encodes non-finite numbers as strings. */
export function time(value: number | string | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-"
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

export function formatMessages(messages: ReadonlyArray<MessagingMessage>) {
  return messages
    .map((message) =>
      [
        `${message.topic}#${message.seq}`,
        time(message.time),
        message.writer,
        ...(message.type === "message" ? [] : [`[${message.type}]`]),
        ...(message.hidden ? ["(hidden)"] : []),
        oneLine(message.data),
      ].join("  "),
    )
    .join(EOL)
}
