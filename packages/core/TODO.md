# TODO

## Event stream: SSE ids and replay on reconnect

### Current behaviour (verified in code)

- The server emits no SSE event ids. Each live event is framed as `data: <json>\n\n`
  (`packages/server/src/event-feed.ts:29-31`). The only `id` is the `evt_…` id inside the JSON payload
  (`packages/schema/src/event.ts:9-11`), not an SSE `id:` field.
- The connected frame carries a fresh id inside its JSON (`packages/server/src/handlers/event.ts:13-19`).
  Keepalives are `: heartbeat` comments (`handlers/event.ts:21`).
- Nothing reads `Last-Event-ID`. A search of `packages/**/*.ts` finds it only in
  `packages/client/test/solid-connection.test.ts:177`, which asserts the reconnect request sends **no**
  such header, even after the test stream emits an `id:` line.
- There is no replay. `EventFeed.publish` returns early when there are no subscribers
  (`event-feed.ts:50`), and each subscriber gets a fresh `Queue.dropping` at subscribe time
  (`event-feed.ts:75-79`). A dropped connection loses every event it missed.
- The contract says so. `packages/protocol/src/groups/event.ts:51` describes `event.subscribe` as
  "Volatile by contract … events during disconnection are missed", and `packages/core/src/bus.ts:121-127`
  describes `subscribe()` as "nothing before or across a disconnect".
- Clients recover by resyncing, not by replay. `packages/client/src/solid/connection.ts:212` (`resync`)
  reconnects, and `packages/client/src/solid/data.ts:601-606` refetches `session.active()` on each
  `server.connected`.

**Answer:** no event ids on the wire, no `Last-Event-ID` handling, no replay.

### Why this is not implemented yet

A working version touches the server feed and handler, the protocol endpoint (the header has to be
declared for the generated clients), the generated promise and effect clients (`check:generated`), and
the client connection loop. That is well over the 150-line budget for one change.

### Minimal design

1. **Wire ids.** `frame()` emits `id: <event.id>\n` before `data:`. Event ids are `evt_` plus
   `ascending()` (`packages/schema/src/identifier.ts`), so they sort in creation order within a process.
   The connected frame gets no SSE id, so it never moves the cursor.
2. **Bounded replay buffer.** `EventFeed.make` keeps the last N encoded frames with their ids (N = 1024,
   and a byte cap of about 4 MiB). Record every `OpenCodeEvent` even when there are no subscribers, which
   means dropping the early return at `event-feed.ts:50` while the buffer is enabled.
3. **Resume.** `subscribe(lastEventID?)`:
   - If the id is in the buffer, enqueue the frames after it, then go live.
   - If it is unknown or evicted, emit a `server.resync_required` event. Clients already refetch on
     `server.connected`, so they should refetch on this event too.
4. **Handler.** `handlers/event.ts` reads the `last-event-id` request header and passes it to
   `feed.subscribe`.
5. **Client.** Track the last delivered id in `SharedEvents` (`packages/client/src/shared-events.ts`) and
   send `Last-Event-ID` on reconnect. That needs the header declared on `event.subscribe` in
   `packages/protocol/src/groups/event.ts`, then regenerated clients (`bun run check:generated`).
6. **Durable events (optional later step).** With `events.persist` on, durable events can also be read
   from `Bus.log({ aggregateID, after })` (`packages/core/src/bus.ts:156-160`) when the ring has evicted
   them. Volatile events (deltas and the like) are never persisted, so only the ring can replay them.

### Caveats

- The ring is per process. Another server process, or a workerd isolate restart, gives an unknown id,
  which falls through to the resync path.
- Ids only order events within one process. Do not compare ids across processes. Look up the ring
  position instead.
- Memory is bounded by N frames and the byte cap, so an idle server keeps about 4 MiB.

### Tests to add when implemented

- `frame()` output includes `id:` and the event's `evt_` id.
- Subscribing with a buffered id replays only the later events, then continues live.
- An unknown or evicted id yields `server.resync_required`.
- Events published with no subscribers appear in the buffer.
- The handler reads the `last-event-id` header.
- The client sends `Last-Event-ID` after a reconnect. This replaces the assertion at
  `solid-connection.test.ts:177`, which pins the current behaviour.
