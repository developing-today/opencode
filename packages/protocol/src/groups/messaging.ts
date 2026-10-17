import { Messaging } from "@opencode/schema/messaging"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { ConflictError, InvalidRequestError } from "../errors.js"

const root = "/api/messaging"

export class MessagingNotFoundError extends Schema.TaggedError<MessagingNotFoundError>()(
  "MessagingNotFoundError",
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

const error = [MessagingNotFoundError, InvalidRequestError, ConflictError]

const data = <S extends Schema.Top>(schema: S) => Schema.Struct({ data: schema })

export const MessagingGroup = HttpApiGroup.make("server.messaging")
  .add(
    HttpApiEndpoint.post("messaging.send", `${root}/message`, {
      payload: Messaging.SendInput,
      success: data(Messaging.SendResult),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.send",
        summary: "Send message",
        description:
          "Write a message to a topic or directly to a session. A soft write limit refusal fails with a conflict unless force is set.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.user", `${root}/user`, {
      payload: Messaging.UserInput,
      success: data(Messaging.SendResult),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.user",
        summary: "Send user message",
        description: "Send a message from the acting session to the person, optionally showing it to the root session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.query", `${root}/query`, {
      payload: Messaging.Query,
      success: data(Messaging.QueryResult),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.query",
        summary: "Query messages",
        description: "Read or search messages visible to the viewer across topics.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.inspect", `${root}/inspect`, {
      payload: Messaging.InspectInput,
      success: data(Messaging.Message),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.inspect",
        summary: "Inspect message",
        description: "Return one message with its delete and restore operations.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.visibility", `${root}/visibility`, {
      payload: Messaging.VisibilityInput,
      success: data(Messaging.VisibilityResult),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.visibility",
        summary: "Change message visibility",
        description: "Hide or restore messages, or a topic's default visibility, for the given viewers.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.settings", `${root}/settings`, {
      payload: Messaging.SettingsInput,
      success: data(Messaging.Topic),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.settings",
        summary: "Update topic settings",
        description: "Change a topic's write mode, limited writers, or description.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.subscribe", `${root}/subscribe`, {
      payload: Messaging.SubscribeInput,
      success: data(Messaging.Topic),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.subscribe",
        summary: "Subscribe to topic",
        description: "Subscribe a session to a topic with a delivery mode, or remove its subscription.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.topic", `${root}/topic`, {
      payload: Messaging.TopicInput,
      success: data(Messaging.Topic),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.topic",
        summary: "Get topic",
        description: "Return one topic's settings, write policy, and activity.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.topics", `${root}/topics`, {
      payload: Messaging.TopicsInput,
      success: data(Messaging.TopicList),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.topics",
        summary: "List topics",
        description: "List topics filtered by name, participant session, role, kind, or search text.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.chain", `${root}/chain`, {
      payload: Messaging.ChainInput,
      success: data(Messaging.Chain),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.chain",
        summary: "Get session chain",
        description: "Return a session followed by its parents up to the root session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.sessions", `${root}/sessions`, {
      payload: Messaging.SessionsInput,
      success: data(Messaging.SessionList),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.sessions",
        summary: "List sessions",
        description: "List sessions across projects filtered by family, location, agent, activity, or time.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.log", `${root}/log`, {
      payload: Messaging.LogInput,
      success: data(Messaging.Log),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.log",
        summary: "Read session logs",
        description: "Read, grep, or search the transcripts of one or more sessions.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.vars", `${root}/vars`, {
      payload: Messaging.VarsInput,
      success: data(Messaging.Vars),
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.vars",
        summary: "List template variables",
        description: "List topic presets and template variables, optionally with values or a rendered template.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.put("messaging.setVar", `${root}/vars`, {
      payload: Messaging.SetVarInput,
      success: HttpApiSchema.NoContent,
      error,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.setVar",
        summary: "Set template variable",
        description: "Set or remove a custom template variable for a session scope or globally.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("messaging.model.status", `${root}/model`, {
      success: data(Messaging.ModelStatus),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.model.status",
        summary: "Get embedding model status",
        description: "Return the local embedding model's state, download progress, and available tiers.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("messaging.model.configure", `${root}/model`, {
      payload: Messaging.ModelInput,
      success: data(Messaging.ModelStatus),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "messaging.model.configure",
        summary: "Configure embedding model",
        description: "Select the embedding model tier or source, optionally start it now, and return its status.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "messaging",
      description: "Inter-session messaging: topics, messages, visibility, session chains, logs, and embeddings.",
    }),
  )
