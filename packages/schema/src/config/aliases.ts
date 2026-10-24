export * as ConfigAlias from "./aliases.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("ConfigAlias.Info")({
  providers: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Provider aliases mapping alias -> providerID, e.g. { ds: 'deepseek' }",
  }),
  models: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description:
      "Model aliases. Bare key = global alias -> provider/model[#variant]. Scoped key = provider/key -> model[#variant].",
  }),
  variants: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description:
      "Variant/effort aliases. Keys can be bare 'alias', or 'provider/*#alias', '*/model#alias', or 'provider/model#alias'.",
  }),
}) {}
