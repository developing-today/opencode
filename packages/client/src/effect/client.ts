export * as OpenCode from "./client.js"

import { Cause, Context, Effect, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { OpenCodeEvent } from "@opencode/protocol/groups/event"
import { SharedEvents } from "../shared-events.js"
import { ClientError, OpenCode } from "./generated/index.js"
import type { EventSubscribeInput } from "./api/api.js"
import { RpcClientRuntime } from "./rpc.js"
import type { RpcCallOptions } from "../promise/rpc.js"

const CurrentHeaders = Context.Reference<RpcCallOptions["headers"]>("@opencode/client/effect/rpc/headers", {
  defaultValue: () => undefined,
})

export const make = Effect.fn("OpenCode.make")(function* (options?: { readonly baseUrl?: URL | string }) {
  const httpClient = yield* HttpClient.HttpClient
  const raw = yield* OpenCode.make(options).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.mapRequestEffect(httpClient, (request) =>
        Effect.map(CurrentHeaders, (headers) =>
          headers ? HttpClientRequest.setHeaders(request, new Headers(headers)) : request,
        ),
      ),
    ),
  )
  const context = yield* Effect.context()
  // Same base URL handling as the generated client, which the event stream bypasses to keep SSE ids.
  const eventClient =
    options?.baseUrl === undefined
      ? httpClient
      : HttpClient.mapRequest(httpClient, HttpClientRequest.prependUrl(options.baseUrl.toString()))
  // Async iterators throw a squashed cause; retain the native typed failures and defects intact.
  class EventFailure {
    constructor(readonly cause: Cause.Cause<ClientError>) {}
  }
  // The cursor outlives any one subscription, so a subscribe after a failure resumes from the last event consumed.
  let lastEventID: string | undefined
  const shared = SharedEvents.make((signal, onActivity, resume) =>
    Stream.toAsyncIterableWith(
      eventFrames(eventClient, { lastEventID: resume.lastEventID, onEventId: resume.onEventId, onActivity }).pipe(
        Stream.interruptWhen(RpcClientRuntime.aborted(signal)),
        Stream.catchCause((cause) => Stream.fail(new EventFailure(cause))),
      ),
      context,
    ),
  )
  const subscribe = (input?: EventSubscribeInput) => {
    lastEventID = input?.["last-event-id"] ?? lastEventID
    return Stream.fromAsyncIterable(
      shared.subscribe({
        lastEventID,
        onEventId: (id) => {
          lastEventID = id
        },
      }),
      (error) => error,
    ).pipe(
      Stream.catch((error) =>
        Stream.failCause(error instanceof EventFailure ? error.cause : Cause.fail(new ClientError({ cause: error }))),
      ),
    )
  }
  return {
    ...raw,
    event: { ...raw.event, subscribe },
    rpc: Object.assign(
      RpcClientRuntime.make(
        (input, options) => raw.rpc.call(input).pipe(Effect.provideService(CurrentHeaders, options?.headers)),
        () => subscribe(),
      ),
      raw.rpc,
    ),
  }
})

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OpenCodeEvent))

// Reads `GET /api/event` as SSE and yields each event after reporting its id. The generated client decodes
// the same frames but its event type carries no id, so a reconnect could never resume.
function eventFrames(
  client: HttpClient.HttpClient,
  options: {
    readonly lastEventID?: string
    readonly onEventId: (id: string) => void
    readonly onActivity: () => void
  },
) {
  const request = HttpClientRequest.get("/api/event").pipe(
    HttpClientRequest.setHeaders(options.lastEventID === undefined ? {} : { "last-event-id": options.lastEventID }),
  )
  return Stream.unwrap(
    client.execute(request).pipe(
      Effect.mapError((cause) => new ClientError({ cause })),
      Effect.map((response) => {
        if (response.status !== 200)
          return Stream.fail(new ClientError({ cause: { status: response.status } }))
        if (!response.headers["content-type"]?.startsWith("text/event-stream"))
          return Stream.fail(new ClientError({ cause: { contentType: response.headers["content-type"] } }))
        return response.stream.pipe(
          Stream.tap(() => Effect.sync(options.onActivity)),
          Stream.decodeText,
          Stream.pipeThroughChannel(Sse.decode()),
          Stream.mapEffect((frame) =>
            Effect.gen(function* () {
              const event = yield* decodeEvent(frame.data)
              if (frame.id !== undefined) options.onEventId(frame.id)
              return event
            }),
          ),
          Stream.mapError((cause) => new ClientError({ cause })),
        )
      }),
    ),
  )
}
