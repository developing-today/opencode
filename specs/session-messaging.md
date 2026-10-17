# Spec: Session Chain, Logs & Inter-Session Messaging

Status: **Implemented; final review and merge in progress.** The original request is preserved verbatim below. The audit table at the end
tracks every item, where it is implemented, and how it was verified. Re-check this file until every
row is done.

## 0. Process & principles

- First save this spec to a file and re-check it until all items are done. Some may already exist: audit, then finish.
- Deliver complete, end-to-end, best-in-class, built in, plus any other tools needed for full agent-to-agent communication.
- Use one or a few tools with modes. Save context: compact schemas; presets/templates/vars aren't enumerated in schemas but are discoverable via list actions and enum-style tool descriptions.
- No permissions: anything can read anywhere; write limits are soft.

## 1. Sessions

- Chain: own id/name, then each parent up to root, with metadata (workdir, agent, etc.). Default: self (or self + parent); options: more detail, full recursive chain, chain + expanded detail.
- List all sessions globally with the same sort/filter/expand options as topics.
- Logs: search/grep/head/tail/pull any session's active log, with/without tools, thinking, user input, system input, output, etc.

## 2. Messaging & topics

- Send to/receive from other sessions directly; create/write/read arbitrary topics. Topic args accept a preset, template, or any raw name.
- User mode: send a message up to the user, with or without the root session seeing it.
- Standard topics are lazy (not created until used) but standard-named and checkable:
  - per session, all public: `private` (personal scratch), `readonly`, `readwrite`; only the session or its parents may write private/readonly
  - global; per-workdir; per-project; per-git-common-dir
  - family: a parent + all subsessions; root: reach the root session from any subtask

## 3. Messages

- Per-topic incrementing id; at least data, writer session id, timestamp.
- Every message has a `type`. Built-ins (plain message, delete, restore) also carry a system type that sessions can't set directly; plugins can register more. Naming (kind/type vs system.type) is open.
- Search messages; filter by date, increment, writer session.
- Inspect/expand a message to see every delete/restore applied to it.

## 4. Topic settings & listing

- Topics can be read-only or limited-writer: creator lists allowed sessions, optionally + their children and/or ancestors.
- Any session can edit any topic's settings and force-write anywhere.
- List topics read/written by any session, by given session(s)/parent or by topic; sort by creation or last-sent, asc/desc.
- List/inspect can expand first-N and latest-N writers, readers (read-only sessions) and limited writers.

## 5. Hiding ("deleting"); nothing is ever truly deleted

- Any session can hide any message, or set default visibility, for itself or specific sessions; permanently.
- Searches can re-include hidden messages: all, in a date range, or written-by/hidden-by given sessions (or their parents/ancestors).
- Each delete/restore is appended to the topic as its own message (writer, increment, date, for whom, exactly what), itself hidden unless filtering for delete type or showing all deleted.

## 6. Storage & search

- Dedicated tables/indexes so everything is very fast.
- Exact, fuzzy, vector/cosine similarity search; nothing needs an exact match.
- Embedded local LLM so searches match meaning, not just text; mode/config to use a fast remote LLM for advanced search.

## 7. Embedded model

- By default, start downloading in the background on first boot, resuming until complete; overridable by another URL or existing local path.
- Default: highest quality that stays fast on a decent CPU laptop; any size (GBs OK). This MacBook is a good bit above that target, not overkill.
- Selectable built-in tiers: default (e.g. Qwen); step-up (really wants a GPU; this MacBook barely runs it); top (absolutely requires a GPU; this MacBook can't). Potato/old phone: tiny fallback, or skip and mark unavailable here.
- Use open weights (Meta Llama counts). May pull in llama.cpp or any deps/binaries/tools to auto-launch and run.

## 8. Templates & vars

- Add more standard presets as templates, e.g. `{session_id}{separator}{read_write}`, `{global}`, `{global}{separator}{root_sessions_only}`, `{session_id}{separator}{tasks}`, `{session_id}{private_link}{child_id}` with `{private_link}` = `{separator}{bidirectional}{separator}`; also `{to}`, `{from}`, etc. All configurable.
- A list action shows every preset and var, optionally with current values.
- More vars than needed, at least: `{today} {timestamp} {session_start_date} {session_start_date_hour} {all_subsessions} {all_root_sessions} {project_dir} {pwd} {common_dir} {session_dir} {parent_dir} {original_dir} {system_time_zone}`, `{system_time}` (RFC 3339), and `{parent_session_*}`/`{root_session_*}` per session var.

## 9. Session start & injection

- Every session starts with a standard line: current system datetime with timezone.
- Ideally vars can be passed between sessions; else inject via a session-start template and/or frontmatter atop skills/instructions (stripped) that triggers var injection.

Build a best-in-class feature.

---

## Audit

Legend: `todo` not started, `wip` partially built, `done` implemented and verified.

Paths are relative to `packages/`. Tests: `core/test/messaging.test.ts` (service), `core/test/tool-messaging.test.ts`
(Code Mode tools and the session start line), `core/test/session-context-vars.test.ts` (frontmatter injection into
instructions), `core/test/messaging-embedding.test.ts` (model pipeline), `core/test/plugin/messaging.test.ts` (plugin
domain), `server/test/messaging.test.ts` (HTTP), `cli/test/msg.test.ts` (CLI), `tui/test/completion-notices.test.tsx`
(transcript rendering). The local model was also verified end to end on this machine: llama.cpp b11669 and both the
`tiny` and `default` tiers downloaded, verified by sha256, served by `llama-server`, and embedded text
(Qwen3-Embedding-0.6B: 1024 dimensions, ~15 ms per query). A live smoke run of an isolated server drove the CLI and
client end to end (send, unread, topics, chain, semantic and hybrid search, model status), and confirmed that a
`messaging` section in `opencode.json` (separator, custom variable, `tiny` tier) takes effect once a location's plugins
activate.

Known limits: each location applies its messaging config and reranker when its plugins activate, and reapplies the
config when its `messaging` section changes. Session callers use their own directory's settings. Inactive directories
use the built-in defaults; calls without an acting session use the latest active location's defaults.
Direct messages wake their recipient by default, so the `msg` tool tells agents to reply only when an answer is needed
(`deliver: "inbox"` or `"none"` avoids waking).

Test-suite note (environment, not this feature): on a machine with the `mcpx` CLI installed, core tests that activate
the built-in plugins spawn a detached `mcpx daemon` with the isolated test HOME; that daemon starts `codedb mcp`, which
writes `$HOME/.claude/settings.json` into the test HOME. Config discovery tests that walk up to HOME then see the extra
`.claude` directory. With `mcpx` masked on PATH the whole `test/config` directory passes on this branch. Tracked in
developing-today/opencode#14.

Final core verification uses the pinned Bun 1.4.2 against `origin/main` at f9aa962d03. `bun run check` passes lint
with 0 errors and all 36 package type-checks. The generated client and OpenAPI document are in sync, and
`bun run migration --check` passes. With `mcpx` masked, the full core suite reports **6986 pass, 23 skip, 2 fail**
across 7011 tests and 294 files. Both failures reproduce on untouched `origin/main`: the callable-namespace tool
test expects pretty JSON after the upstream compact-JSON change, and the VCS untracked-file test observes 58
spawns against its limit of 40. Focused messaging service/search/log/tool regressions pass 350/350 over 10 runs;
the TUI notices pass 60/60 over 10 runs at widths 40 and 120. Earlier counts made with Bun 1.3.11 are superseded.

Review regressions cover location-isolated config and rerankers, scoped read-pointer advancement, short-token fuzzy
matches, attachment and retained-compaction text, and mixed-case delivered-body round trips. Regex search and log
grep run in a disposable subprocess with a 2-second deadline and disclose incomplete results; a pathological-regex
test verifies that the caller's event loop stays responsive and the subprocess terminates. The deadline regression
also passes on Bun 1.3.11, and a compiled executable smoke test verifies matching and forced timeout.

| #   | Item                                                                                     | Status | Where                                                                                                                                                                                                                         | Verified by                                                                          |
| --- | ---------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0.1 | Spec saved and re-checked                                                                | done   | this file                                                                                                                                                                                                                     | re-checked against the code at the end                                               |
| 0.2 | Built in end to end (core + server/protocol + client)                                    | done   | `core/src/messaging.ts`, `protocol/src/groups/messaging.ts`, `server/src/handlers/messaging.ts`, generated `client.messaging.*`, TUI notices, CLI `opencode msg` / `opencode session chain` and `log`, plugin `ctx.messaging` | server, tool, TUI tests                                                              |
| 0.3 | One or few tools with modes, compact schemas, discoverable presets/vars                  | done   | `core/src/tool/plugin/messaging.ts`: pinned Code Mode tools `comms.msg`, `comms.topics`, `comms.sessions`; enum-style topic help; `topics({ mode: "presets" })`                                                               | tool tests                                                                           |
| 0.4 | No permissions; soft write limits                                                        | done   | no permission checks; `DeniedError` names the rule and `force: true`                                                                                                                                                          | "enforces soft limits"                                                               |
| 1.1 | Session chain (self → root) with metadata and detail levels                              | done   | `Messaging.chain` (depth self/parent/all, detail brief/full, expand children)                                                                                                                                                 | "walks the session chain"                                                            |
| 1.2 | Global session list with topic-equivalent sort/filter/expand                             | done   | `Messaging.sessions` (ids/session sets, parent/none, ancestor, project, directory, agent, search, active, since/until, sort created/updated, order, offset, detail, expand)                                                   | "lists sessions globally"                                                            |
| 1.3 | Session log search/grep/head/tail/pull with part filters                                 | done   | `Messaging.log` + `messaging/log.ts` (parts user/output/thinking/tools/results/system/synthetic/shell/events/compaction; scope all/context; multi-session via `+descendants`)                                                 | "reads, greps and searches session logs"                                             |
| 2.1 | Direct session-to-session send/receive; arbitrary topics; preset/template/raw topic args | done   | `send` (`to`, dm topics auto-subscribed, delivered into the recipient), `query` unread + `wait`; `MessagingVars.topic`                                                                                                        | delivery tests                                                                       |
| 2.2 | User mode (to user, with/without root session seeing it)                                 | done   | `Messaging.user` (root hidden/visible/wake), TUI toast + transcript notice; hidden notices excluded from model context and compaction                                                                                         | "sends messages up to the user", TUI test                                            |
| 2.3 | Lazy standard topics: private/readonly/readwrite per session                             | done   | presets in `messaging/template.ts`; owner + ancestors write private/readonly; listed with `exists: false` before use                                                                                                          | presets + limits + listing tests                                                     |
| 2.4 | Global / workdir / project / git-common-dir topics                                       | done   | `global`, `roots`, `workdir`, `project`, `git` presets; `common_dir` from `.git`/`commondir`                                                                                                                                  | presets test                                                                         |
| 2.5 | Family and root topics                                                                   | done   | `family`, `children`, `tree` (family policy), `root` (tree policy, delivered to the root)                                                                                                                                     | presets + delivery tests                                                             |
| 3.1 | Per-topic increment id, data, writer, timestamp                                          | done   | `messaging_message` (topic_id, seq unique)                                                                                                                                                                                    | delivery tests                                                                       |
| 3.2 | Message `type` + system kind (message/delete/restore) + plugin-registered types          | done   | `type` free label; `kind` system-only (message/delete/restore/settings); `kinds.register` + `send(…, { kind })`; plugin `ctx.messaging.kinds/write`                                                                           | "plugin kinds" test                                                                  |
| 3.3 | Message search by date/increment/writer                                                  | done   | `query` since/until/after/before/from/types/kinds                                                                                                                                                                             | search tests                                                                         |
| 3.4 | Inspect message with its delete/restore history                                          | done   | `Messaging.inspect` returns `ops`                                                                                                                                                                                             | visibility test                                                                      |
| 4.1 | Read-only / limited-writer topics (+children/ancestors)                                  | done   | `settings` mode open/readonly/limited, writers with children/ancestors                                                                                                                                                        | "limited writers" test                                                               |
| 4.2 | Any session may edit settings and force-write                                            | done   | settings unrestricted, recorded as hidden `settings` operations; `force`                                                                                                                                                      | limits tests                                                                         |
| 4.3 | Topic listing by reader/writer/session/parent/topic; sort created/last-sent asc/desc     | done   | `topics` (sessions + role, topics, kinds, search, sort created/last, order)                                                                                                                                                   | listing test                                                                         |
| 4.4 | Expand first-N/latest-N writers, readers, limited writers                                | done   | `writersWindow`, `readersWindow`, `allowedWindow`                                                                                                                                                                             | listing + limited tests                                                              |
| 5.1 | Hide messages for self/specific sessions; default visibility; permanent                  | done   | `visibility` hide/restore per viewer or `*`; no seq = topic default                                                                                                                                                           | visibility test                                                                      |
| 5.2 | Re-include hidden: all, date range, written-by/hidden-by (+ancestors)                    | done   | `hidden` include/only + `hiddenSince/Until`, `hiddenFrom`, `hiddenBy` with session-set expansions                                                                                                                             | visibility test                                                                      |
| 5.3 | Delete/restore appended as hidden audit messages                                         | done   | ops are `delete`/`restore` messages, hidden unless their kind is requested or hidden messages are included                                                                                                                    | visibility test                                                                      |
| 6.1 | Dedicated tables and indexes                                                             | done   | `core/src/messaging/sql.ts` + migration `20261016221426_messaging`; FTS5 trigram index created idempotently at startup                                                                                                        | migration check                                                                      |
| 6.2 | Exact, fuzzy, vector/cosine search                                                       | done   | exact (FTS phrase), regex, fuzzy (trigram FTS + scoring), semantic (cosine over cached vectors), hybrid (RRF)                                                                                                                 | search tests, e2e embeddings                                                         |
| 6.3 | Embedded local model semantic search; remote advanced mode/config                        | done   | background indexer + on-demand embedding; `match: "advanced"` reranks with `messaging.search.model` (or the session's small model) for tools, HTTP, CLI and plugins alike; remote OpenAI-compatible embeddings                | tool test (stub reranker), embedding tests                                           |
| 7.1 | Background resumable download on first boot; URL/path override                           | done   | `messaging/embedding.ts` (Range resume, sha256, retry with backoff); CLI servers autostart ~15 s after boot; `messaging.embedding` url/path, `OPENCODE_EMBEDDING`, `OPENCODE_DISABLE_EMBEDDING`                               | embedding tests, e2e run                                                             |
| 7.2 | Tiers: default / step-up / top / potato (or unavailable)                                 | done   | tiny MiniLM-L6 (25 MB), default Qwen3-Embedding-0.6B Q8_0, step-up 4B Q8_0, top 8B F16; hardware gate (this M3 Pro 36 GB: step-up yes, top no)                                                                                | embedding tests, e2e status                                                          |
| 7.3 | Open weights; llama.cpp auto-launch                                                      | done   | pinned llama.cpp b11669 per platform with sha256; `llama-server --embedding` lifecycle                                                                                                                                        | e2e run                                                                              |
| 8.1 | Standard preset templates, configurable                                                  | done   | 17 presets incl. the spec examples; `messaging.presets` / `messaging.vars`                                                                                                                                                    | presets tests                                                                        |
| 8.2 | List action for presets and vars with optional current values                            | done   | `topics({ mode: "presets", values: true, render })`, `POST /api/messaging/vars`                                                                                                                                               | presets tests                                                                        |
| 8.3 | Full var set incl. parent*session*_/root*session*_                                       | done   | `contextVars`/`timeVars`/`sessionFields` in `messaging/template.ts`; custom vars                                                                                                                                              | presets tests                                                                        |
| 9.1 | Session-start datetime + timezone line                                                   | done   | `core/src/tool/plugin/messaging.ts` session hooks (context, compaction, generate) render `messaging.session_start` (default: creation time with timezone, session ID, lineage); stable per session so the prompt cache holds  | "renders the session start line", "starts every request with the session start line" |
| 9.2 | Var passing / session-start template / stripped frontmatter injection                    | done   | `set_var` scoped to a session and inherited by subsessions; `vars:` frontmatter in AGENTS.md/instructions and skills (tool, prompt and API paths)                                                                             | frontmatter test, skill tests                                                        |
