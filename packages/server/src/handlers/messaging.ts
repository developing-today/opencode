import { Messaging } from "@opencode/core/messaging"
import { MessagingEmbedding } from "@opencode/core/messaging/embedding"
import { ConfigMessaging } from "@opencode/schema/config/messaging"
import { ConflictError, InvalidRequestError } from "@opencode/protocol/errors"
import { MessagingNotFoundError } from "@opencode/protocol/groups/messaging"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"

export const MessagingHandler = HttpApiBuilder.group(Api, "server.messaging", (handlers) =>
  Effect.gen(function* () {
    const messaging = yield* Messaging.Service
    const embedding = yield* MessagingEmbedding.Service
    return handlers
      .handle("messaging.send", (ctx) => messaging.send(ctx.payload).pipe(wrap))
      .handle("messaging.user", (ctx) => messaging.user(ctx.payload).pipe(wrap))
      .handle("messaging.query", (ctx) => messaging.query(ctx.payload).pipe(wrap))
      .handle("messaging.inspect", (ctx) => messaging.inspect(ctx.payload).pipe(wrap))
      .handle("messaging.visibility", (ctx) => messaging.visibility(ctx.payload).pipe(wrap))
      .handle("messaging.settings", (ctx) => messaging.settings(ctx.payload).pipe(wrap))
      .handle("messaging.subscribe", (ctx) => messaging.subscribe(ctx.payload).pipe(wrap))
      .handle("messaging.topic", (ctx) => messaging.topic(ctx.payload).pipe(wrap))
      .handle("messaging.topics", (ctx) => messaging.topics(ctx.payload).pipe(wrap))
      .handle("messaging.chain", (ctx) => messaging.chain(ctx.payload).pipe(wrap))
      .handle("messaging.sessions", (ctx) => messaging.sessions(ctx.payload).pipe(wrap))
      .handle("messaging.log", (ctx) => messaging.log(ctx.payload).pipe(wrap))
      .handle("messaging.vars", (ctx) => messaging.vars(ctx.payload).pipe(wrap))
      .handle("messaging.setVar", (ctx) =>
        messaging.setVar(ctx.payload).pipe(mapErrors, Effect.as(HttpApiSchema.NoContent.make())),
      )
      .handle("messaging.model.status", () => embedding.status().pipe(Effect.map((data) => ({ data }))))
      .handle("messaging.model.configure", (ctx) =>
        Effect.gen(function* () {
          // A bare tier keeps the config shorthand; a URL or path needs the detailed form.
          yield* embedding.configure(
            ctx.payload.url || ctx.payload.path
              ? new ConfigMessaging.Embedding({ tier: ctx.payload.tier, url: ctx.payload.url, path: ctx.payload.path })
              : ctx.payload.tier,
          )
          if (ctx.payload.start) yield* embedding.start()
          return { data: yield* embedding.status() }
        }),
      )
  }),
)

function wrap<A, R>(effect: Effect.Effect<A, Messaging.Error, R>) {
  return effect.pipe(
    mapErrors,
    Effect.map((data) => ({ data })),
  )
}

function mapErrors<A, R>(effect: Effect.Effect<A, Messaging.Error, R>) {
  return effect.pipe(
    Effect.catchTags({
      "Messaging.NotFoundError": (error) => Effect.fail(new MessagingNotFoundError({ message: error.message })),
      "Messaging.InvalidError": (error) => Effect.fail(new InvalidRequestError({ message: error.message })),
      "Messaging.DeniedError": (error) =>
        Effect.fail(new ConflictError({ message: error.message, resource: "messaging" })),
    }),
  )
}
