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

A replaced server should never refuse a client that was already connected. Today the old
process closes its listener on `SIGTERM` and drains running sessions for
`OPENCODE_SHUTDOWN_GRACE_MS`, so a replacement can only start after the old one exits. Clients
see a refused connection in that gap.

A supervisor (systemd socket activation, or the managed service) would own the listening socket
and hand it over. The protocol needs to settle:
- Listener owner: the supervisor holds the socket and passes it to each server, so no process
  closes the port during a replacement.
- Successor-ready signal: the successor reports that it has booted and loaded its config before
  the predecessor begins its drain, so traffic moves only to a server that can answer it.
- Drain handoff: the predecessor stops accepting new work on the shared socket while it keeps
  streaming existing sessions, and exits when they finish or the grace deadline passes.
- Client behaviour: a client that gets a refused connection during a handoff retries against the
  same URL instead of starting a server of its own.

Until this exists, a replacement still has a gap. Systemd unit restarts and `nixos switch` both
hit it, and neither can be verified on a real service manager from the test suite.
