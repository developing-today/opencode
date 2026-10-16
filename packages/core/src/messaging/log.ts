export * as MessagingLog from "./log.js"

import { DateTime } from "effect"
import type { Messaging } from "@opencode/schema/messaging"
import type { SessionMessage } from "../session/message.js"

/** Parts shown when a log request does not choose: what a reader of the conversation would see. */
export const defaultParts: ReadonlyArray<Messaging.LogPart> = ["user", "output", "tools", "synthetic"]

export interface Entry {
  readonly session: string
  readonly message: string
  readonly index: number
  readonly part: Messaging.LogPart
  readonly time: number
  /** The searchable content. */
  readonly text: string
  /** Display prefix kept out of search, such as the sender of a delivered message. */
  readonly label?: string
  readonly tool?: string
}

const millis = (time: DateTime.Utc) => DateTime.toEpochMillis(time)

/** Flattens one session's messages into ordered log entries for the requested parts. */
export function entries(
  session: string,
  messages: ReadonlyArray<SessionMessage.Info>,
  parts: ReadonlySet<Messaging.LogPart>,
): Entry[] {
  return messages.flatMap((message) => {
    const time = millis(message.time.created)
    const entry = (index: number, part: Messaging.LogPart, text: string, tool?: string, label?: string): Entry[] =>
      parts.has(part) && text.trim() !== ""
        ? [
            {
              session,
              message: message.id,
              index,
              part,
              time,
              text,
              ...(tool ? { tool } : {}),
              ...(label ? { label } : {}),
            },
          ]
        : []
    switch (message.type) {
      case "user":
        return entry(
          0,
          "user",
          [
            message.text,
            ...(message.files ?? []).map(
              (file) => `[file: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "attachment")}]`,
            ),
            ...(message.agents ?? []).map((agent) => `[agent: ${agent.name}]`),
            ...(message.skills ?? []).map((skill) => `[skill: ${skill.name}]`),
          ]
            .filter(Boolean)
            .join("\n"),
        )
      case "synthetic": {
        const notice = synthetic(message)
        return entry(0, "synthetic", notice.text, undefined, notice.label)
      }
      case "system":
        return entry(0, "system", message.text)
      case "skill":
        return entry(0, "system", `[skill ${message.name}]\n${message.text}`)
      case "shell":
        return entry(0, "shell", `$ ${message.command}\n${message.output?.output ?? ""}`.trimEnd())
      case "compaction":
        return entry(
          0,
          "compaction",
          message.status === "failed" ? `[compaction failed: ${message.error.message}]` : message.summary,
        )
      case "agent-switched":
        return entry(0, "events", `[agent ${message.previous ? `${message.previous} → ` : ""}${message.agent}]`)
      case "model-switched":
        return entry(0, "events", `[model ${message.model.providerID}/${message.model.id}]`)
      case "location-switched":
        return entry(0, "events", `[moved to ${message.location.directory}]`)
      case "idle":
        return entry(0, "events", `[idle: ${message.outcome}${message.error ? ` (${message.error.message})` : ""}]`)
      case "assistant":
        return message.content.flatMap((item, index) => {
          if (item.type === "text") return entry(index, "output", item.text)
          if (item.type === "reasoning") return entry(index, "thinking", item.text)
          const call = entry(
            index,
            "tools",
            `${item.name}(${summarize(item.state.input)}) → ${item.state.status}`,
            item.name,
          )
          const result =
            item.state.status === "completed"
              ? contentText(item.state.content)
              : item.state.status === "error"
                ? `error: ${item.state.error.message}${item.state.content ? `\n${contentText(item.state.content)}` : ""}`
                : ""
          return [...call, ...entry(index, "results", result, item.name)]
        })
    }
  })
}

function contentText(
  content: ReadonlyArray<{ readonly type: string; readonly text?: string; readonly name?: string }>,
) {
  return content
    .map((item) => (item.type === "text" ? (item.text ?? "") : `[${item.type}${item.name ? `: ${item.name}` : ""}]`))
    .join("\n")
}

/**
 * Delivered messages wrap their body in `<message …>` attributes for the model; the log shows the sender, topic
 * and body instead, so text and semantic search match the message rather than its envelope.
 */
function synthetic(message: SessionMessage.Synthetic) {
  const metadata = message.metadata
  const body = /^<message\b[^\n]*>\n([\s\S]*?)\n<\/message>\s*$/.exec(message.text)?.[1]
  if (metadata?.source === "messaging" && body !== undefined) {
    const from = typeof metadata.from === "string" ? metadata.from : "unknown"
    const topic = typeof metadata.topic === "string" ? ` → ${metadata.topic}` : ""
    return { text: body, label: `✉ ${from}${topic}` }
  }
  return { text: message.description ? `${message.description}\n${message.text}` : message.text }
}

function summarize(input: unknown) {
  const text = typeof input === "string" ? input : JSON.stringify(input)
  return text.length > 160 ? `${text.slice(0, 157)}...` : text
}

/** Shortens long entries to a head and tail around an omission marker. */
export function clip(text: string, chars: number) {
  if (text.length <= chars) return text
  const head = Math.ceil(chars * 0.7)
  const tail = Math.max(0, chars - head - 20)
  return `${text.slice(0, head)} …[${text.length - head - tail} chars]… ${tail > 0 ? text.slice(-tail) : ""}`
}
