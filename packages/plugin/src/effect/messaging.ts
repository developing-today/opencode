import type { MessagingApi, MessagingSendInput } from "@opencode/client/effect/api"
import type { Messaging } from "@opencode/schema/messaging"
import type { Effect, Scope } from "effect"
import type { MessagingKind } from "../messaging.js"

export interface MessagingDomain extends MessagingApi<unknown> {
  readonly kinds: {
    /** Registers a system message kind for as long as the plugin stays loaded. */
    readonly register: (kind: MessagingKind) => Effect.Effect<void, unknown, Scope.Scope>
    readonly list: () => Effect.Effect<ReadonlyArray<MessagingKind>>
  }
  /** Writes a message with a registered system kind, which sessions cannot choose themselves. */
  readonly write: (
    input: MessagingSendInput & { readonly kind: string },
  ) => Effect.Effect<Messaging.SendResult, unknown>
}
