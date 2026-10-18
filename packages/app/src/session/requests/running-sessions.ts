import type { SessionInfo } from "@opencode/client/promise"

export type RunningSession = { session: SessionInfo; running: boolean; children: RunningSession[] }

// The sessions below `sessionID` that run or still have running work below them, each with its own at any depth.
// A subagent that finished stays as the parent of work it started that still runs, so that work is not dropped.
export function runningSessions(input: {
  sessionID: string
  sessions: SessionInfo[]
  status: (id: string) => "idle" | "running"
}) {
  const children = Map.groupBy(input.sessions, (session) => session.parentID)
  const seen = new Set([input.sessionID])

  const walk = (parentID: string): RunningSession[] =>
    (children.get(parentID) ?? [])
      .toSorted((a, b) => a.time.created - b.time.created)
      .flatMap((session) => {
        if (seen.has(session.id)) return []
        seen.add(session.id)
        const below = walk(session.id)
        const running = input.status(session.id) === "running"

        return running || below.length > 0 ? [{ session, running, children: below }] : []
      })

  return walk(input.sessionID)
}
