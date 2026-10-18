import type { OpenCodeEvent, SessionInfo } from "@opencode/client/promise"

// Announces a session the mock server already serves, as when a subagent starts another subagent. The event opens the
// new session's own durable history, so it is the first in its aggregate.
export function sessionCreated(info: SessionInfo): OpenCodeEvent {
  return {
    id: `evt_session_created_${info.id}`,
    created: info.time.created,
    type: "session.created",
    durable: { aggregateID: info.id, seq: 0, version: 1 },
    location: info.location,
    data: {
      sessionID: info.id,
      projectID: info.projectID,
      location: info.location,
      parentID: info.parentID,
      slug: info.id,
      title: info.title,
      agent: info.agent,
      version: "dev",
    },
  }
}
