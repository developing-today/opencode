export * as ConfigMessaging from "./messaging.js"

import { Schema } from "effect"
import { PositiveInt, optional } from "../schema.js"

const Delivery = Schema.Literals(["none", "inbox", "wake"])

export class Remote extends Schema.Class<Remote>("Config.Messaging.Remote")({
  url: Schema.String.annotate({
    description: "Base URL of an OpenAI-compatible API, for example https://api.openai.com/v1",
  }),
  model: Schema.String.annotate({ description: "Embedding model name" }),
  key: Schema.String.pipe(optional).annotate({
    description: "API key; {env:NAME} reads it from the environment",
  }),
  dimensions: PositiveInt.pipe(optional),
}) {}

export class Embedding extends Schema.Class<Embedding>("Config.Messaging.Embedding")({
  tier: Schema.String.pipe(optional).annotate({
    description: 'Built-in model tier: "tiny", "default", "step-up", "top", or "off" (default: "default")',
  }),
  url: Schema.String.pipe(optional).annotate({ description: "GGUF download URL used instead of the tier's model" }),
  path: Schema.String.pipe(optional).annotate({ description: "Existing local GGUF file used instead of downloading" }),
  pooling: Schema.Literals(["last", "mean", "cls"]).pipe(optional).annotate({
    description: "Pooling for a custom model (default: last)",
  }),
  query: Schema.String.pipe(optional).annotate({
    description: "Instruction prefix for search queries with a custom model",
  }),
  server: Schema.String.pipe(optional).annotate({
    description: "llama-server executable to use instead of the downloaded llama.cpp build",
  }),
  autostart: Schema.Boolean.pipe(optional).annotate({
    description: "Download and start the model in the background at startup (default: true)",
  }),
  gpu_layers: Schema.Int.pipe(optional).annotate({ description: "Layers to offload to the GPU (default: all)" }),
  threads: PositiveInt.pipe(optional),
  remote: Remote.pipe(optional).annotate({
    description: "Embeddings endpoint used when the local model is unavailable, or always when the tier is off",
  }),
}) {}

export class Search extends Schema.Class<Search>("Config.Messaging.Search")({
  match: Schema.Literals(["exact", "regex", "fuzzy", "semantic", "hybrid", "advanced"]).pipe(optional).annotate({
    description: 'Default match mode for message and log searches (default: "hybrid")',
  }),
  model: Schema.String.pipe(optional).annotate({
    description:
      "Fast model (provider/model) that reranks advanced searches; defaults to the session provider's small model",
  }),
}) {}

export class Info extends Schema.Class<Info>("Config.Messaging")({
  presets: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Topic presets: name to template, overriding or extending the built-in presets",
  }),
  vars: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Template variables: name to value or template, overriding or extending the built-in variables",
  }),
  session_start: Schema.String.pipe(optional).annotate({
    description:
      "Template added to every session's instructions when it starts (default: the current date, time and timezone). An empty string disables it",
  }),
  delivery: Schema.Struct({
    direct: Delivery.pipe(optional).annotate({ description: 'Direct messages (default: "wake")' }),
    root: Delivery.pipe(optional).annotate({ description: 'Messages to the root topic (default: "wake")' }),
    user: Schema.Literals(["hidden", "visible", "wake"]).pipe(optional).annotate({
      description: 'Whether the root session sees messages sent to the user (default: "visible")',
    }),
  })
    .pipe(optional)
    .annotate({ description: "Default delivery of messages into sessions" }),
  search: Search.pipe(optional),
  embedding: Schema.Union([Schema.String, Embedding]).pipe(optional).annotate({
    description: 'Local embedding model: a tier name ("tiny", "default", "step-up", "top", "off") or detailed settings',
  }),
}) {}
