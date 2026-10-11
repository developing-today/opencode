import { expect } from "bun:test"
import { OpenCode } from "@opencode/client/promise"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { EventFeed } from "../src/event-feed"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

type Seen = { readonly id?: string; readonly type: string }
type Handler = (request: Request) => Promise<Response>

// Subscribes through the promise client, recording each event with the SSE id the client reports for it.
function listen(base: string, lastEventID?: string) {
  const client = OpenCode.make({ baseUrl: base })
  const controller = new AbortController()
  const received: Seen[] = []
  let staged: string | undefined
  const done = (async () => {
    try {
      for await (const event of client.event.subscribe({
        signal: controller.signal,
        lastEventID,
        onEventId: (id) => {
          staged = id
        },
      })) {
        received.push({ id: staged, type: event.type })
        staged = undefined
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  return { received, stop: () => controller.abort(), done }
}

async function createSession(base: string) {
  const response = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Replay" }),
  })
  expect(response.status).toBe(200)
  await response.text()
}

async function until(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}

// Waits until the list stops growing, so the control stream has seen everything the server produced.
async function settle(list: Seen[]) {
  let last = -1
  while (list.length !== last) {
    last = list.length
    await Bun.sleep(100)
  }
}

const idOf = (list: Seen[]) => list.findLast((seen) => seen.id !== undefined)?.id

async function replaysMissedEvents(handler: Handler) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
  const base = `http://127.0.0.1:${server.port}`
  // The control stream never disconnects, so it is the ground truth for every event the server produced.
  const control = listen(base)
  try {
    await until(() => control.received.length === 1)
    const first = listen(base)
    await until(() => first.received.length === 1)
    await createSession(base)
    await until(() => first.received.length > 1)
    await settle(control.received)
    expect(first.received).toEqual(control.received.slice(0, first.received.length))

    const cursor = idOf(first.received)
    first.stop()
    await first.done

    // Produced while the first client is disconnected.
    await createSession(base)
    await createSession(base)
    await settle(control.received)
    const cursorIndex = control.received.findIndex((seen) => seen.id === cursor)
    const missed = control.received.slice(cursorIndex + 1)
    expect(missed.length).toBeGreaterThanOrEqual(2)

    const second = listen(base, cursor)
    try {
      await until(() => second.received.length === missed.length + 1)
      expect(second.received[0]).toEqual({ id: undefined, type: "server.connected" })
      expect(second.received.slice(1)).toEqual(missed)

      // Once replay is done the stream stays live.
      await createSession(base)
      await settle(control.received)
      await until(() => second.received.length === control.received.length - cursorIndex)
      expect(second.received.slice(1)).toEqual(control.received.slice(cursorIndex + 1))
    } finally {
      second.stop()
      await second.done
    }
  } finally {
    control.stop()
    await control.done
    server.stop(true)
  }
}

async function resyncsAcrossRestart(before: Handler, after: Handler) {
  const previous = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: before })
  const previousBase = `http://127.0.0.1:${previous.port}`
  const first = listen(previousBase)
  let cursor: string | undefined
  try {
    await until(() => first.received.length === 1)
    await createSession(previousBase)
    await until(() => first.received.length > 1)
    await settle(first.received)
    cursor = idOf(first.received)
  } finally {
    first.stop()
    await first.done
    previous.stop(true)
  }
  if (cursor === undefined) throw new Error("expected an SSE id from the first process")

  // A restart is a new feed with a new instance id, so the old cursor must not replay anything.
  const restarted = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: after })
  const base = `http://127.0.0.1:${restarted.port}`
  const second = listen(base, cursor)
  try {
    await until(() => second.received.length === 2)
    expect(second.received[0]).toEqual({ id: undefined, type: "server.connected" })
    const resync = second.received[1]
    expect(resync?.type).toBe("server.resync")
    expect(resync?.id?.split(":")[0]).not.toBe(cursor.split(":")[0])

    await createSession(base)
    await until(() => second.received.length > 2)
    expect(second.received[2]?.id?.split(":")[0]).toBe(resync?.id?.split(":")[0])
  } finally {
    second.stop()
    await second.done
    restarted.stop(true)
  }
}

async function resyncsPastReplayWindow(handler: Handler) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler })
  const base = `http://127.0.0.1:${server.port}`
  const control = listen(base)
  try {
    await until(() => control.received.length === 1)
    const first = listen(base)
    await until(() => first.received.length === 1)
    await createSession(base)
    await until(() => first.received.length > 1)
    await settle(first.received)
    const cursor = idOf(first.received)
    first.stop()
    await first.done

    // Push the cursor out of the window: more frames than the ring keeps after it.
    const behindCursor = () => control.received.length - control.received.findIndex((seen) => seen.id === cursor) - 1
    while (behindCursor() <= EventFeed.ReplayCapacity) {
      for (let i = 0; i < 50; i++) await createSession(base)
      await settle(control.received)
    }
    expect(behindCursor()).toBeGreaterThan(EventFeed.ReplayCapacity)
    const head = idOf(control.received)

    const second = listen(base, cursor)
    try {
      await until(() => second.received.length === 2)
      expect(second.received[0]).toEqual({ id: undefined, type: "server.connected" })
      // The resync carries the head id, so the client's cursor moves to the state it just refetched.
      expect(second.received[1]).toEqual({ id: head, type: "server.resync" })

      await createSession(base)
      await settle(control.received)
      const live = control.received.slice(control.received.findIndex((seen) => seen.id === head) + 1)
      expect(live.length).toBeGreaterThan(0)
      await until(() => second.received.length === 2 + live.length)
      expect(second.received.slice(2)).toEqual(live)
      expect(second.received.filter((seen) => seen.type === "server.resync")).toHaveLength(1)
    } finally {
      second.stop()
      await second.done
    }
  } finally {
    control.stop()
    await control.done
    server.stop(true)
  }
}

it.live("a reconnect with Last-Event-ID receives exactly the events it missed, in order", () =>
  Effect.gen(function* () {
    const handler: Handler = yield* ServerFetch.make(options)
    yield* Effect.promise(() => replaysMissedEvents(handler))
  }).pipe(Effect.scoped),
)

it.live("a cursor from a previous process instance gets one resync and then live events", () =>
  Effect.gen(function* () {
    const before: Handler = yield* ServerFetch.make(options)
    const after: Handler = yield* ServerFetch.make(options)
    yield* Effect.promise(() => resyncsAcrossRestart(before, after))
  }).pipe(Effect.scoped),
)

it.live(
  "a cursor older than the replay window gets one resync at the head id, then live events",
  () =>
    Effect.gen(function* () {
      const handler: Handler = yield* ServerFetch.make(options)
      yield* Effect.promise(() => resyncsPastReplayWindow(handler))
    }).pipe(Effect.scoped),
  120_000,
)
