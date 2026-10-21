import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js"
import type { Data } from "@opencode/client/solid"

// Waits before each retry of a failed read. After the last one, a reconnect or a new view starts over.
const RETRY_DELAYS = [250, 500, 1_000, 2_000, 4_000]

/**
 * A subagent view opened before its ancestors walks up to the root, whose tree holds the whole family. A failed
 * read is retried with a bounded backoff.
 */
export function createFamilyDiscovery(input: {
  session: Pick<Data["session"], "get" | "root" | "sync">
  sessionID: Accessor<string>
  connected: Accessor<boolean>
  /** Schedules a retry and returns a function that cancels it. Defaults to a timer. */
  schedule?: (retry: () => void, delay: number) => () => void
}) {
  const schedule =
    input.schedule ??
    ((retry, delay) => {
      const timer = setTimeout(retry, delay)
      return () => clearTimeout(timer)
    })
  const [attempt, setAttempt] = createSignal(0)
  let failures = 0

  createEffect(() => {
    attempt()
    if (!input.connected()) {
      failures = 0
      return
    }
    if (!input.session.get(input.sessionID())?.parentID) return
    const root = input.session.root(input.sessionID())
    const state = { stale: false, cancel: () => {} }
    onCleanup(() => {
      state.stale = true
      state.cancel()
    })
    void (input.session.get(root) ? input.session.sync(root, { children: true }) : input.session.sync(root)).then(
      () => {
        failures = 0
      },
      () => {
        if (state.stale) return
        const delay = RETRY_DELAYS[failures++]
        if (delay === undefined) return
        state.cancel = schedule(() => setAttempt((value) => value + 1), delay)
      },
    )
  })
}
