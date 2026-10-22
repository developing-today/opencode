# Roadmap

This is the roadmap for the fork. It is grouped by area. Each area lists its items by horizon: Now, Next, Later and Ideas. How the roadmap works, and how it connects to specs and plans, is in [`planning/README.md`](planning/README.md).

A row here records intent. It does not settle a product question and it is not a go-ahead to build.

Sources: open issues, [`TODO.md`](TODO.md), the fork notice in [`README.md`](README.md), and the merged PRs of 2026-10-20 and 2026-10-21.

## Areas

| Area                                                        | Current focus                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| [Nested subsessions](#nested-subsessions-and-their-asks)    | Shipped across the TUI, the app and ACP. One follow-up left     |
| [mcpx integration](#mcpx-integration)                       | Where the flake gets mcpx                                       |
| [Serve handover and restarts](#serve-handover-and-restarts) | Prove the handover under real systemd                           |
| [Routing, cost and plans](#routing-cost-and-plans)          | Feature requests for failover, cost display and cache use       |
| [Plugin API](#plugin-api)                                   | Gaps found while building v2 plugins                            |
| [CI and test health](#ci-and-test-health)                   | A main branch whose checks are green                            |
| [Upstream sync](#upstream-sync)                             | Daily sync verified working                                     |

## Nested subsessions and their asks

Subagents can launch subagents. Pending permissions and questions from any depth now reach the root session in the app, the TUI and ACP.

| Title                                      | Horizon | Status   | Intent                                                                                                                                                          | Links |
| ------------------------------------------ | ------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| Nest the TUI mini Select subagent menu     | Now     | proposed | The follow-up left behind when the TUI changes merged.                                                                                                          | #78   |

## mcpx integration

The fork projects mcpx tools into Code Mode, starts a detached daemon with just-in-time secret prompts, and cleans up leaked daemons. The mcpx source lives in `developing-today/code`.

| Title                                       | Horizon | Status   | Intent                                                                                                         | Links |
| ------------------------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------- | ----- |
| Say where the flake gets mcpx               | Now     | proposed | The flake builds `opencode` with no `mcpx` unless the consumer passes one in.                                  | #82   |

## Serve handover and restarts

`opencode serve` can hand its listening socket to a successor with no refused connection. See [`TODO.md`](TODO.md) for the protocol and its open parts.

| Title                                    | Horizon | Status   | Intent                                                                                                            | Links           |
| ---------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------------- | --------------- |
| Verify the handover under real systemd   | Now     | proposed | `Type=notify` with `NotifyAccess=all` is only tested with stand-ins. Also decide on the rare teardown race.       | #81             |
| Session state outside the server process | Later   | idea     | A restarted server reattaches to in-flight work, so restarts stop being visible. Open questions are in `TODO.md`. | [TODO](TODO.md) |

## Routing, cost and plans

The fork adds named route pools, scheduled weights, request telemetry with cost, route review tools and plan or quota tracking.

| Title                                         | Horizon | Status | Intent                                                                           | Links |
| --------------------------------------------- | ------- | ------ | -------------------------------------------------------------------------------- | ----- |
| Failover across credentials on 429            | Later   | idea   | Switch to another credential when quota runs out, through `credential.activate`. | #6    |
| Show authoritative cost in the desktop header | Later   | idea   | Use the models.dev `cost_usd`.                                                   | #7    |
| Stitch cost across response chunks            | Later   | idea   | Count the cost of a continued response in `route_attempt`.                       | #8    |
| Prompt cache use across model pools           | Later   | idea   | Through `compatibility.cacheFormat`.                                             | #9    |
| Auto-check plan steps                         | Later   | idea   | Use turn file change summaries to tick plan steps.                               | #10   |

## Plugin API

| Title                    | Horizon | Status   | Intent                                                                                  | Links |
| ------------------------ | ------- | -------- | --------------------------------------------------------------------------------------- | ----- |
| Close the v2 plugin gaps | Next    | proposed | Plugins cannot list child sessions, read live provider pricing or learn the server URL. | #19   |

## CI and test health

| Title                                    | Horizon | Status   | Intent                                                                                                      | Links |
| ---------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| A Nix check that completes               | Next    | proposed | Replace `nix-eval` and `nix-hashes`, which have effectively never finished.                                 | #49   |

## Upstream sync

No open items. The daily Jules sync issue (#41) closed as transient on 2026-10-21 after three consecutive scheduled successes; see Done.

## Done

| Title                                                            | Date       | Result   |
| ---------------------------------------------------------------- | ---------- | -------- |
| Pool variants kept when route provider settings apply            | 2026-10-22 | #266     |
| ROADMAP records the #41 closure and #109 completion in Done      | 2026-10-22 | #260     |
| Storybook family bumped to 10.6.2; Dependabot groups its updates | 2026-10-22 | #258     |
| models-snapshot refresh runs on this fork against main           | 2026-10-21 | #252     |
| Daily upstream sync verified working — #41 was transient         | 2026-10-21 | #41      |
| ROADMAP Done table records the #250 completion                   | 2026-10-21 | #251     |
| ROADMAP Done table records the #244 completion                   | 2026-10-21 | #245     |
| ROADMAP Done table records the #197 and #232 completions         | 2026-10-21 | #249     |
| Editor SSE and IDE lock-file ports parsed strictly               | 2026-10-21 | #247     |
| restart-driver OC_PORT validation pinned by tests                | 2026-10-21 | #248     |
| restart-driver validates OC_PORT, falls back to 4096             | 2026-10-21 | #242     |
| Route attempts timed to the end of the model's response          | 2026-10-21 | #234     |
| Config substitution supports `{env:VAR:-fallback}` defaults      | 2026-10-21 | #232     |
| Release is deliberate dispatch only; dead `dev` trigger dropped  | 2026-10-21 | #229     |
| Containers build on main pushes; GHCR push is a dispatch input   | 2026-10-21 | #226     |
| `docs-update` gated to upstream; dead fork cron dropped          | 2026-10-21 | #225     |
| Provider session grouping walks to the root session              | 2026-10-21 | #220     |
| `opencode run` stdin EOF behaviour documented (#193 docs)        | 2026-10-21 | #219     |
| Vite bumped to 8.2.4 in app and desktop, patch rebased           | 2026-10-21 | #214     |
| ROADMAP Done table records the #201 and #210 completions         | 2026-10-21 | #213     |
| MCP security updates grouped into one Dependabot PR              | 2026-10-21 | #211     |
| `@modelcontextprotocol/*` updates grouped into one Dependabot PR | 2026-10-21 | #207     |
| MCP SDK bumped to 2.3.0, client patch re-based                   | 2026-10-21 | #205     |
| Dependabot set up for bun; vite bump landed with lockfile        | 2026-10-20 | #198     |
| mcpx daemon autostart fail-open branches covered by tests        | 2026-10-20 | #186     |
| Stale node_modules FOD hashes, `nix-hashes` updater fixed       | 2026-10-20 | #189     |
| turbo.json `#test` tasks deduplicated, with a guard test         | 2026-10-20 | #183     |
| `jules-action` pinned to a commit SHA (v1.0.0)                   | 2026-10-20 | #185     |
| `queue: max` on the six deploy workflows                         | 2026-10-20 | #180     |
| Console and stats service tests run via turbo                    | 2026-10-20 | #144     |
| `actions/checkout` aligned to the v4.3.1 standard pin            | 2026-10-20 | #170     |
| Ast-grep lint rule tests run in CI                               | 2026-10-20 | #155     |
| Changelog and update service tests run via turbo                 | 2026-10-20 | #142     |
| `plugin-github` tests pass on Windows                            | 2026-10-20 | #174     |
| `runScript` tests run on Windows                                 | 2026-10-20 | #167     |
| `verify-package` packs `plugin-github`                           | 2026-10-20 | #166     |
| `actions/github-script` aligned to v8.0.0                        | 2026-10-20 | #165     |
| Transport test expects the protocol `SessionNotFoundError`       | 2026-10-20 | #158     |
| ACP follow stale-attach guard covered by a test                  | 2026-10-20 | #154     |
| `queue: max` on models-snapshot, docs-update and stats           | 2026-10-20 | #157     |
| Timeout caps on every job                                        | 2026-10-19 | #61      |
| Shell tool description follows config edits                      | 2026-10-19 | #67      |
| Tests that need no ambient `rg`                                  | 2026-10-19 | #72      |
| Subtask commands enforce the subagent depth limit                | 2026-10-19 | #127     |
| mcpx plugin respects `daemon.autostart=false`                    | 2026-10-19 | #134     |
| Follow nested subsessions in ACP                                 | 2026-10-18 | #58      |
| Nested asks reach the root in the app                            | 2026-10-18 | #60      |
| Nested asks reach the root in the TUI                            | 2026-10-18 | #64      |
| Copilot prompt cache key and plan endpoint                       | 2026-10-18 | #45, #42 |
| Document the `OPENCODE_MCPX_*` variables                         | 2026-10-18 | #48      |
| Validate `OPENCODE_MCPX_DAEMON_IDLE_EXIT` before spawning        | 2026-10-18 | #68      |
| Report incompatible health when the `--server` probe ends on 503 | 2026-10-18 | #71      |
| Housekeeping scripts point at this fork                          | 2026-10-18 | #44      |
| Workflows on GitHub-hosted runners, concurrency groups           | 2026-10-18 | #51, #50 |
| Run e2e for PRs whose head branch is named main                  | 2026-10-18 | #73      |
| Document `mcpx-cleanup`                                          | 2026-10-18 | #76      |
| Sessions in a parent cycle are not dropped                       | 2026-10-18 | #84      |
| Concurrency groups that do not drop runs                         | 2026-10-18 | #86      |
| `mcpx-cleanup` on macOS and Windows                              | 2026-10-19 | #107     |
