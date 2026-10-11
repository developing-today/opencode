# TODO

## Externally persisted session state so restarts are invisible

Today a restart of `opencode serve` interrupts running sessions. Graceful drain and config reload
cover the common cases, but the server still has to exit, and anything still running at the
grace deadline is cut and only resumed from the claimed-execution record on the next boot.

Long term, session state (messages, execution claims, pending tool calls, and streamed output)
should live in a store that outlives the server process. A restarted server would then reattach
to in-flight work instead of resuming it, so restarts stop being visible to the user.

Open questions:
- Which store owns session state (the local database, or a separate process the server connects to)?
- How does a restarted server reattach to a model stream that was in flight when it died?
- How do clients that were mid-turn learn that the work continued instead of failing?

## Supervisor and handoff protocol for replacing `opencode serve`

A replaced server should never refuse a client that was already connected. Clients see a refused
connection only when nothing holds the listening socket, so the supervisor keeps one.

Implemented in `serve` (the Node build; see the runtime note below):
- Listener inheritance: with `LISTEN_PID` naming the server and `LISTEN_FDS` set, `serve` serves the
  socket on fd 3 instead of binding `hostname:port`. `LISTEN_PID` and `LISTEN_FDS` are removed from
  the environment once read, so children do not see them. Children spawned by `serve` do not inherit
  fd 3: Node and Bun spawn children with only the descriptors they map (checked by running a shell
  from a process that held the socket).
- Drain: `SIGTERM` closes the server's listener, stops answering idle keep-alive connections, and
  sends `Connection: close` on responses still in progress. Requests already accepted are still
  answered, and running sessions and non-SSE requests finish within `OPENCODE_SHUTDOWN_GRACE_MS`.
  A second `SIGTERM` ends the wait. Event streams are not waited for; they end when the process
  exits, after the events of sessions that finished during the drain.
- Ready: once `serve` is listening and its application is ready, it sends `READY=1` to
  `$NOTIFY_SOCKET` (sd_notify, `Type=notify`) and prints `opencode: ready` on stdout. In `--stdio`
  mode the line goes to stderr, because stdout carries the JSON handshake. The check runs in-process
  rather than over the socket: a request sent to a shared socket could be answered by a predecessor.
- Runtime: Bun 1.4's `node:http`, `Bun.serve` and `Bun.listen` ignore an inherited socket and bind a
  port of their own, but `node:net` adopts it (`net.Server.listen({ fd })`). On Bun the listener is a net
  server on fd 3, and each accepted connection is handed to the unchanged http server
  (`packages/server/src/inherited-socket.ts`). The Node build keeps `http.listen({ fd })`. `READY=1` uses
  `sendto(2)` on Bun and `systemd-notify` on Node, because neither runtime has a unix datagram socket.
- Wrapper: `bin/opencode.cjs` passes fd 3 to the server it starts and rewrites `LISTEN_PID` to that
  child's pid, so the handover works through the installed launcher.

Handover order a supervisor must follow:
1. The supervisor creates the listening socket and keeps its own descriptor open for the whole
   service lifetime. Closing the last descriptor is what refuses connections.
2. Start the successor with the socket as fd 3, `LISTEN_FDS=1`, and `LISTEN_PID` set to the
   successor's pid. The successor starts accepting on the same socket while the predecessor still runs.
3. Wait for the successor's `READY=1` (or `opencode: ready`). Only then send `SIGTERM` to the
   predecessor. Sending it earlier moves traffic to a server that has not proven it can answer.
4. The predecessor closes its own copy of the socket and drains. The kernel keeps the socket because
   the supervisor and the successor still hold it, so connections queue for the successor instead
   of being refused.
5. When the predecessor exits, the supervisor keeps its descriptor until the next handover.

Verified by `packages/cli/test/serve-handover.test.ts` with real processes on both runtimes: a 10 ms
client loop across a handover saw no refused connection and no failed request, while a control run
without a supervisor's socket refused connections on every restart. The control code path is the same
binary without `LISTEN_FDS`, so it binds the port itself as before.

Still open:
- Systemd units: `Type=notify` needs `NotifyAccess=all`, because the notifying process is the server
  child, not the unit's main pid, when the wrapper starts it. Not verified under a real systemd user
  session. The tests stand in for systemd with a socket the test process owns and a fake notify socket.
- Clients: a client that gets a refused connection during a handoff should retry the same URL instead
  of starting a server of its own. Not implemented in the client.
- Residual race: a connection the predecessor accepted in the last instant before it closes can get a
  `503` (`service_stopping`) or a reset when its request arrives after teardown has begun. The
  handover runs (about a thousand requests) showed none; the control showed one in each run.
- Session state: restarts still interrupt sessions that outlive the grace period; see the section above.
