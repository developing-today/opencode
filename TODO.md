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
