# Roadmap

This is the roadmap for the fork. It is grouped by area. Each area lists its items by horizon: Now, Next, Later and Ideas. How the roadmap works, and how it connects to specs and plans, is in [`planning/README.md`](planning/README.md).

A row here records intent. It does not settle a product question and it is not a go-ahead to build.

Sources: open issues, [`TODO.md`](TODO.md), the fork notice in [`README.md`](README.md), and the merged PRs of 2026-10-18.

## Areas

| Area                                                        | Current focus                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| [Nested subsessions](#nested-subsessions-and-their-asks)    | Shipped across the TUI, the app and ACP. One follow-up left     |
| [mcpx integration](#mcpx-integration)                       | Where the flake gets mcpx, and the shell tool description       |
| [Serve handover and restarts](#serve-handover-and-restarts) | Prove the handover under real systemd                           |
| [Routing, cost and plans](#routing-cost-and-plans)          | Feature requests for failover, cost display and cache use       |
| [Plugin API](#plugin-api)                                   | Gaps found while building v2 plugins                            |
| [CI and test health](#ci-and-test-health)                   | A main branch whose checks are green                            |
| [Upstream sync](#upstream-sync)                             | Daily sync keeps failing                                        |

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
| Shell tool description follows config edits | Next    | proposed | The description keeps the boot-time `shell_timeout`, so the model is told the wrong default.                   | #67   |

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
| `unit (linux)` green on main             | Now     | proposed | `packages/sdk/test/transport.test.ts` fails in both variants. Find the cause before touching the assertion. | #62   |
| Tests that need no ambient `rg`          | Next    | proposed | Ripgrep and search-tool tests fall through to a download the harness forbids.                               | #72   |
| Windows test fixes                       | Next    | proposed | The `runScript` tests hardcode `/bin/sh`.                                                                   | #63   |
| Timeout caps on every job                | Next    | proposed |                                                                                                             | #61   |
| Build each PR commit once                | Next    | proposed | Test and check run on both push and pull request.                                                           | #59   |
| A Nix check that completes               | Next    | proposed | Replace `nix-eval` and `nix-hashes`, which have effectively never finished.                                 | #49   |

## Upstream sync

| Title                     | Horizon | Status   | Intent                                                                                             | Links |
| ------------------------- | ------- | -------- | -------------------------------------------------------------------------------------------------- | ----- |
| Daily upstream sync works | Now     | proposed | The Jules sync gets past setup, then dies in "Assemble Jules payload" with exit 126 and no output. | #41   |

## Done

| Title                                                            | Date       | Result   |
| ---------------------------------------------------------------- | ---------- | -------- |
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
