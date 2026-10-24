import { blob, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Messaging } from "@opencode/schema/messaging"

// Inter-session messaging. Deliberately no foreign keys to sessions: topics and messages outlive the
// sessions that wrote them, and nothing here is ever deleted. Hiding a message records an operation
// message plus the current visibility state; the original row never changes.

export const MessagingTopicTable = sqliteTable(
  "messaging_topic",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    name: text().notNull(),
    /** Standard kind detected from the name (private, family, dm, ...) or `custom`. */
    kind: text().notNull(),
    preset: text(),
    /** Session a standard topic belongs to. */
    owner: text(),
    creator: text().notNull(),
    description: text(),
    /** Explicit write mode; null applies the kind's default policy. */
    mode: text().$type<Messaging.WriteMode>(),
    writers: text({ mode: "json" }).$type<Messaging.Writer[]>(),
    last_seq: integer().notNull().default(0),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
    time_last: integer(),
  },
  (table) => [
    uniqueIndex("messaging_topic_name_idx").on(table.name),
    index("messaging_topic_kind_idx").on(table.kind),
    index("messaging_topic_owner_idx").on(table.owner),
    index("messaging_topic_time_created_idx").on(table.time_created),
    index("messaging_topic_time_last_idx").on(table.time_last),
  ],
)

export const MessagingMessageTable = sqliteTable(
  "messaging_message",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    topic_id: integer()
      .notNull()
      .references(() => MessagingTopicTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    /** System kind (message, delete, restore, or a plugin kind). Writers cannot choose it. */
    kind: text().notNull(),
    type: text().notNull(),
    writer: text().notNull(),
    data: text().notNull(),
    meta: text({ mode: "json" }).$type<Record<string, unknown>>(),
    reply: integer(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("messaging_message_topic_seq_idx").on(table.topic_id, table.seq),
    index("messaging_message_topic_kind_seq_idx").on(table.topic_id, table.kind, table.seq),
    index("messaging_message_writer_time_idx").on(table.writer, table.time_created),
    index("messaging_message_time_created_idx").on(table.time_created),
  ],
)

/** Current visibility per message (seq) or topic default (seq 0) and viewer (session ID or `*`). */
export const MessagingVisibilityTable = sqliteTable(
  "messaging_visibility",
  {
    topic_id: integer()
      .notNull()
      .references(() => MessagingTopicTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    viewer: text().notNull(),
    hidden: integer({ mode: "boolean" }).notNull(),
    by: text().notNull(),
    op_seq: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.topic_id, table.seq, table.viewer] }),
    index("messaging_visibility_viewer_idx").on(table.viewer),
    index("messaging_visibility_by_idx").on(table.by, table.time_updated),
  ],
)

export const MessagingParticipantTable = sqliteTable(
  "messaging_participant",
  {
    topic_id: integer()
      .notNull()
      .references(() => MessagingTopicTable.id, { onDelete: "cascade" }),
    session_id: text().notNull(),
    reads: integer().notNull().default(0),
    writes: integer().notNull().default(0),
    last_read_seq: integer().notNull().default(0),
    time_first_read: integer(),
    time_last_read: integer(),
    time_first_write: integer(),
    time_last_write: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.topic_id, table.session_id] }),
    index("messaging_participant_session_write_idx").on(table.session_id, table.time_last_write),
    index("messaging_participant_session_read_idx").on(table.session_id, table.time_last_read),
  ],
)

export const MessagingSubscriptionTable = sqliteTable(
  "messaging_subscription",
  {
    topic_id: integer()
      .notNull()
      .references(() => MessagingTopicTable.id, { onDelete: "cascade" }),
    session_id: text().notNull(),
    delivery: text().$type<Messaging.Delivery>().notNull(),
    by: text().notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.topic_id, table.session_id] }),
    index("messaging_subscription_session_idx").on(table.session_id),
  ],
)

/** Custom template variables. Scope is `global` or a session ID, inherited by its descendants. */
export const MessagingVarTable = sqliteTable(
  "messaging_var",
  {
    scope: text().notNull(),
    name: text().notNull(),
    value: text().notNull(),
    by: text().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.scope, table.name] })],
)

/** Embedding cache. Source is `message` (key: message id) or `log` (key: session message id and index). */
export const MessagingVectorTable = sqliteTable(
  "messaging_vector",
  {
    source: text().notNull(),
    key: text().notNull(),
    model: text().notNull(),
    hash: text().notNull(),
    dimensions: integer().notNull(),
    vector: blob({ mode: "buffer" }).notNull(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.key, table.model] }),
    index("messaging_vector_model_source_idx").on(table.model, table.source),
  ],
)
