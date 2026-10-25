# Roadmap

This is the roadmap for the fork. It is grouped by area. Each area lists its items by horizon: Now, Next, Later and Ideas. How the roadmap works, and how it connects to specs and plans, is in [`planning/README.md`](planning/README.md).

A row here records intent. It does not settle a product question and it is not a go-ahead to build.

Sources: open issues, [`TODO.md`](TODO.md), the fork notice in [`README.md`](README.md), and the merged PRs of 2026-10-20, 2026-10-21 and 2026-10-22.

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
| ROADMAP Done records the #426 completion                         | 2026-10-25 | #427     |
| ModelAlias bare scoped targets keep variant slashes              | 2026-10-25 | #425     |
| ROADMAP Done records the #423 completion                         | 2026-10-25 | #424     |
| ROADMAP Done records the #420 completion                         | 2026-10-25 | #421     |
| ROADMAP Done records the #418 completion                         | 2026-10-25 | #419     |
| ROADMAP Done records the #416 completion                         | 2026-10-25 | #417     |
| ModelAlias own-property lookups, rejects padded targets          | 2026-10-25 | #415     |
| ModelAlias rejects empty model alias targets                     | 2026-10-24 | #413     |
| ModelAlias validates provider and variant alias targets          | 2026-10-24 | #410     |
| ROADMAP Done records the #408 completion                         | 2026-10-24 | #409     |
| ROADMAP Done records the #404 completion                         | 2026-10-24 | #405     |
| ModelAlias validates alias variants, settles chains at limit     | 2026-10-24 | #403     |
| Mini permission prompt names the asking subagent                 | 2026-10-24 | #401     |
| ROADMAP Done records the #397 completion                         | 2026-10-24 | #400     |
| ROADMAP Done records the #395 completion                         | 2026-10-24 | #396     |
| ROADMAP Done records the #387 and #385 completions               | 2026-10-24 | #393     |
| Bare model aliases expand in the session runner                  | 2026-10-24 | #390     |
| ROADMAP Done records the #380 and #124 completions               | 2026-10-24 | #388     |
| Permission and question docks name the subagent that asked       | 2026-10-24 | #384     |
| ROADMAP Done records the #375 completion                         | 2026-10-24 | #381     |
| Failed Console reload keeps the policy refusal                   | 2026-10-24 | #377     |
| ROADMAP Done records the #368 and #123 completions               | 2026-10-24 | #372     |
| Running menu rooted at the session tree root                     | 2026-10-24 | #370     |
| ROADMAP Done records the #368 completion                         | 2026-10-24 | #369     |
| ROADMAP Done records the #362 and #240 bulk completions          | 2026-10-24 | #367     |
| Model-route pool descriptions reach the OpenAPI document         | 2026-10-24 | #364     |
| ROADMAP Done records the #358 and #360 completions               | 2026-10-24 | #363     |
| ROADMAP Done records the #355 and #116 completions               | 2026-10-24 | #361     |
| Doc-env-var guard matches whole variable names                   | 2026-10-24 | #359     |
| Docs stop promising twelve dead OPENCODE_EXPERIMENTAL_* env vars | 2026-10-23 | #357     |
| ROADMAP Done records the #352 and #114 completions               | 2026-10-23 | #356     |
| Docs stop promising eleven dead OPENCODE_* env vars              | 2026-10-23 | #354     |
| ROADMAP Done records the #350 completion                         | 2026-10-23 | #353     |
| ROADMAP Done records the #347 and #105 completions               | 2026-10-23 | #351     |
| Docs stop promising dead web-search, shell-timeout and LSP flags | 2026-10-23 | #349     |
| ROADMAP Done records the #343 and #345 completions               | 2026-10-23 | #348     |
| WSL CLI discovery output framed against banner suffix lines      | 2026-10-23 | #346     |
| ROADMAP Done records the #339 and #340 completions               | 2026-10-23 | #344     |
| WSL discovery requires the managed CLI path suffix               | 2026-10-23 | #342     |
| ROADMAP Done records the #337 completion                         | 2026-10-23 | #341     |
| ROADMAP Done records the #332, #334 and #117 completions         | 2026-10-23 | #338     |
| Docs stop promising OPENCODE_PORT for the desktop local server   | 2026-10-23 | #336     |
| WSL CLI discovery takes the last path-shaped line                | 2026-10-23 | #335     |
| ROADMAP Done records the #330 completion                         | 2026-10-23 | #333     |
| ROADMAP Done records the #328 completion                         | 2026-10-23 | #331     |
| ROADMAP Done records the #326 completion                         | 2026-10-23 | #329     |
| ROADMAP Done records the #324 completion                         | 2026-10-23 | #327     |
| ROADMAP Done records the #322 completion                         | 2026-10-23 | #325     |
| ROADMAP Done records the #115 and #319 completions               | 2026-10-23 | #323     |
| Dead experimental env setters removed from desktop launch        | 2026-10-23 | #321     |
| ROADMAP Done records the #314 and #317 completions               | 2026-10-23 | #320     |
| ROADMAP Done records the #103 completion                         | 2026-10-23 | #318     |
| ROADMAP Done records the #108 and #310 completions               | 2026-10-23 | #315     |
| Docs stop promising OPENCODE_SERVER_USERNAME                     | 2026-10-23 | #313     |
| Embedded web UI disabled when the desktop asks for it            | 2026-10-23 | #312     |
| ROADMAP Done records the #308 completion                         | 2026-10-23 | #311     |
| ROADMAP Done records the #306 completion                         | 2026-10-22 | #309     |
| ROADMAP Done records the #304 completion                         | 2026-10-22 | #307     |
| ROADMAP Done records the #302 completion                         | 2026-10-22 | #305     |
| ROADMAP Done records the #299 and #294 completions               | 2026-10-22 | #303     |
| WSL probeDistro answers land on their own lines                  | 2026-10-22 | #301     |
| ROADMAP Done records the #297 completion                         | 2026-10-22 | #300     |
| ROADMAP Done records the #295 completion                         | 2026-10-22 | #298     |
| ROADMAP Done records the #290 completion                         | 2026-10-22 | #296     |
| Probe, registration and discovery prints land on their own lines | 2026-10-22 | #293     |
| ROADMAP Done records the #280 and #284 completions               | 2026-10-22 | #289     |
| CLI version frame BEGIN marker lands on its own line             | 2026-10-22 | #287     |
| ROADMAP Done records the #281 completion                         | 2026-10-22 | #285     |
| CLI version frame END marker lands on its own line               | 2026-10-22 | #283     |
| ROADMAP Done records the #272, #273, #276 and #277 completions   | 2026-10-22 | #282     |
| Remote CLI version output framed against banner inventions       | 2026-10-22 | #279     |
| Desktop CLI version line validated, not the last v token         | 2026-10-22 | #278     |
| CLI version read from the last version-shaped line               | 2026-10-22 | #275     |
| ROADMAP Done records the #265 and #269 completions               | 2026-10-22 | #274     |
| WSL probe verdict read from its answer line past banners         | 2026-10-22 | #271     |
| Remote CLI version read past login-shell banners                 | 2026-10-22 | #270     |
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
