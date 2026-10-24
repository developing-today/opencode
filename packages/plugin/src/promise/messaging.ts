import type { MessagingApi } from "@opencode/client/promise/api"
import type { Messaging } from "@opencode/schema/messaging"
import type { MessagingKind } from "../messaging.js"
import type { Registration } from "./registration.js"

export interface MessagingDomain extends MessagingApi {
  readonly kinds: {
    /** Registers a system message kind until disposed or the plugin unloads. */
    readonly register: (kind: MessagingKind) => Promise<Registration>
    readonly list: () => Promise<ReadonlyArray<MessagingKind>>
  }
  /** Writes a message with a registered system kind, which sessions cannot choose themselves. */
  readonly write: (
    input: Parameters<MessagingApi["send"]>[0] & { readonly kind: string },
  ) => Promise<Messaging.SendResult>
}
