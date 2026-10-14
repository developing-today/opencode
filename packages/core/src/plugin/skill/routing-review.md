<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Routing Review

Review how the user's model pools and categories perform, and recommend changes
they can approve. Start read-only. Change nothing until the user approves a
specific change, then make only that change.

## 0. Before you start

- Take the baseline with `route_stats` at `hours: 168` (a week). Use `hours: 24`
  only for "what is happening now". Pass `route` to focus on one pool.
- `route_stats` and `route_adjust` are offered only when some pool is at
  autonomy `agent` or has no autonomy set. If `route_stats` is missing, every
  pool is at `fixed`, `rules`, `adaptive` or `predictive`. Say so, and offer to
  set `autonomy: "agent"` on the pools the user wants reviewed. That is a config
  change, so ask first. You can still read the configuration and the categories.
- Read the `routes` part of the result before anything else. It holds each pool's
  configuration and its members, configured or not.
- Check how much evidence there is: the total attempts and the attempts per pool.
  Thin data means thin recommendations (see the minimums in section 3).

## 1. What exists

### Pools (`experimental.model_routes` in the OpenCode config)

A pool is an ordered list of targets. OpenCode and OpenChamber show it as the
model `opencode-route/<id>`, under "OpenCode routes" in the model picker. A
category's model can be a pool. A pool can also list another pool as a target.

A target is `provider/model`, `provider/model#variant`, or an object with
`model`, `defaultVariant`, `variants` (variant remap) and `until` (epoch ms, after
which the target leaves the pool).

Pool settings:

- `selection`:
  - `ordered` (default): the first ready target takes the traffic, and the rest
    are failover, ranked by effective weight.
  - `round-robin`: new sessions rotate across targets in proportion to weight.
  - `weighted`: each new session draws a target with probability proportional to
    its weight.
  - In every mode a session stays on its target while that target works. Failover
    moves it.
- `weights`: relative weight per target, default 1. Ordered pools also rank
  failover by effective weight, and equal weights keep the configured order.
- `schedules`: time-bound weight changes for this pool's targets (section below).
- `health`: `firstTokenTimeoutMs` (default 10000), `maxResponseTimeMs`,
  `minOutputTokensPerSecond`, `sampleWindow` (5), `slowThreshold` (3),
  `cooldownMs` (60000), `quotaCooldownMs` (900000). A target that fails goes on
  cooldown.
- `budgets`: per target, `requestsPerMinute`, `requestsPerDay`,
  `tokensPerMinute`, `tokensPerDay`, `softLimit` (default 0.9). A target at its
  soft limit is passed over until it recovers.
- `attempts`: tries per target before failover (default 1). Retries happen only
  before any output, so no tool call runs twice.
- `hedgeAfterMs`: if the target has produced no output after this many
  milliseconds, the next target gets the same request. The first answer wins.
  This costs a duplicate request whenever the first target is slow.
- `autonomy`, each level including the ones before it:
  - `fixed`: configured order with failover only. No weights or adjustments.
  - `rules`: adds selection modes, weights, budgets and provider rate-limit holds.
  - `adaptive`: adds the scheduled review of history, which lowers or skips
    targets.
  - `predictive`: adds hour-of-day and quota-message prediction.
  - `agent`: adds `route_stats` and `route_adjust`.
  - Unset keeps everything, the behavior from before levels existed.

A target is left out of a selection for one of these reasons, and `route_stats`
reports each as an `excluded` count:

- `cooldown`: recent failures.
- `provider-limit`: the provider said it is rate-limited.
- `user-skip`: the user said "avoid", or a skip was recorded.
- `soft-budget`: at its budget soft limit.
- `already-tried`: it already failed earlier in this same request.

### How effective weight is formed

Start from the configured weight, then apply in order:

1. Schedules: the global `experimental.model_route_schedules`, then the pool's own
   `schedules`. `factor` multiplies, `weight` replaces.
2. User preferences from OpenChamber sentence rules. "Prefer" multiplies by 3
   unless a factor or weight is given. "Avoid" removes the target from rotation
   at every autonomy level.
3. Recorded adjustments (`route_adjust` and the tuner). These do not apply on
   `fixed` pools.
4. Quota demotion. A target demoted after quota errors keeps 1% of its weight
   until it recovers.

### Schedules

Both `experimental.model_route_schedules` (across pools) and a pool's `schedules`
take a `when` window and either `factor` (multiplies) or `weight` (replaces):

- `daysOfWeek`: `mon`..`sun` or 0 (Sunday) to 6. `daysOfMonth`: 1 to 31, or -1 for
  the last day. Every set field must match: they combine with AND.
- `start` and `end`: local "HH:mm", `end` exclusive. A start later than the end runs
  past midnight.
- `timezone`: an IANA name such as `America/Chicago`.
- `from` and `until`: epoch ms that bound when the window applies. Leave them out
  for a recurring schedule.
- An empty `when` means always.

### Adjustments and tuning

- `route_adjust` (an agent tool, approval required): `add` a weight change
  (`factor` above 1 favours a target, below 1 lightens it; `weight` sets it) or a
  `skip`, for targets whose provider/model contains `match`. Give `hours` for a
  duration, a recurring window, or both. `list` shows what is in force. `remove`
  takes an `id`. Use it for facts like "promo credits expire Friday". Adjustments
  expire on their own.
- `route_stats` with `apply: true`: puts its suggestions in force for 30 minutes.
  They only lower a target's share or skip it.
- `experimental.model_route_tuning`: `enabled` (default false), `intervalMinutes`
  (15), `windowHours` (24). This is the automatic version of the same suggestions.
  Its `notes` take one line each as `match: text`. A note that states a return
  time ("back in 3 hours", "reset at 2026-01-01T06:00:00Z") skips the matching
  targets until then. The other notes are shown to you through `route_stats`.

### What the measurements are

`route_stats` reads OpenCode's routing history. Each request is one `route_attempt`
row, and each selection is one `route_decision` row. No prompts or responses are
stored.

Per target (`provider/model`), over the window: attempts, failures, timeouts,
average first-output latency, average speed, errors grouped by tag, code and
status (with the latest message), cooldowns, provider rate-limit windows
(`remaining`, `limit`, `resetsInSeconds`, age of the report), requests and tokens
in the last minute and day, predictions (busy hours; "quota returns at"), hedge
win rates, suggestions and the adjustments in force.

Per pool: its configuration; `attempts`, `sessions`, `decisions`; `reasons`
(`ordered`, `adjusted`, `sticky`, `drawn`, `no-candidates`); input-token
percentiles `p50` and `p90`; and per member:

- `configuredWeight`, `attempts`, `failures`, `timeouts`, `failureRate`
- `firstTokenMs` and `tokensPerSecond` (medians), `inputTokens` (median), `errorTags`
- `offered`: selections it was eligible for. `chosen`: selections it was used in,
  sticky turns included.
- `draws` and `drawsWon`: new-session draws it was eligible for, and won. Only
  draws are decided by weight.
- `expectedShare`: the share its weight promised across those draws.
  `takeRate`: the share it actually won. Compare the two.
- `excluded`: selections it was left out of, by reason.

Not in the data: cost per token, answer quality, which OpenChamber category a
request came from (neither route table records a category), plan names, fees,
quota sizes, reset days or expiry dates, and any quota the provider does not
report in its rate-limit headers or quota messages.

### Categories and classification (OpenChamber)

- Categories are OpenChamber's task classes. The built-in ones are `trivial`
  (mechanical work), `research` (read and explain), `implement` (bounded
  engineering), `review` (inspect a change) and `hard` (ambiguous, high-stakes or
  unknown-cause work). Each has a model, a variant and an agent. A category with
  no model uses the fallback. Users can add their own.
- The file is `routing.json` in the OpenChamber data directory:
  `$OPENCHAMBER_DATA_DIR`, or `~/.config/openchamber` by default. It stores only
  what differs from the built-in defaults. You may read it. If you cannot,
  ask the user to paste the categories from Settings → Routing.
- Jev, the classifier, picks one category per request with a confidence. Below
  `minConfidence` (default 0.6), the fallback model is used.
- Stickiness keeps a session on its model until consistent prompts move it: two
  consistent prompts to leave the starting model, three to leave a model it
  moved to, and a confidence of 0.9 counts as strong. Cache preservation is on by
  default.
- Auto is OpenChamber's mode that picks a category for each request. It is not a
  pool.
- Category choices are not written to route history. So `route_stats` cannot
  split a pool's traffic by category. Judge category fit from the categories'
  descriptions, the pool a category points at, and the user's account.

### Providers and models: where each thing changes

| You want to change                                           | Where                                                                                                                                                                 |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A pool's members, order, weights, selection, health, budgets | `experimental.model_routes` in the OpenCode config, or OpenChamber Settings → Model pools                                                                             |
| Weights for a time of day, across pools                      | `experimental.model_route_schedules`                                                                                                                                  |
| A temporary fact ("credits expire Friday")                   | `route_adjust`, with approval                                                                                                                                         |
| Automatic review of history                                  | `experimental.model_route_tuning`                                                                                                                                     |
| Which model a category uses                                  | OpenChamber Settings → Routing → categories                                                                                                                           |
| Sentence rules ("weekdays 9 to 5, downweight deepseek")      | OpenChamber Settings → Routing → Route by sentence                                                                                                                    |
| Turn a provider off                                          | `disabled_providers` in the OpenCode config, or the provider toggle in Settings → Providers. Its models are then unavailable, so pool targets on it cannot be reached |
| Add or connect a provider                                    | `/connect` in OpenCode, or Settings → Providers. Never by editing credential files                                                                                    |
| Hide a model from the OpenChamber picker                     | The OpenChamber model picker. A UI-only setting: OpenCode and pools still use the model                                                                               |

### Plans, quotas and money

- Measured quota comes only from `route_stats`: the `rateLimit` windows and the
  `predictions` that carry a reset time. Only providers that report those have it.
- Plan facts are not visible to any tool: the plan name, fee, quota per window,
  reset day, credit expiry and promotions. The user can paste them, or read them
  on the Usage page in OpenChamber, which shows quota for the providers it
  supports.
- Prices are not in route data. Use only prices the user states.
- Never read or print credentials, API keys, token files or the OpenChamber auth
  files.

## 2. Procedure

1. Baseline: `route_stats` at `hours: 168`, plus `route` for any pool the user
   named. Note the total attempts.
2. Inventory: the pools and their members (from `routes`), the categories (from
   `routing.json` or the user), and, only if the question needs them, the plan
   facts. Ask for the plan facts in the table in section 5.
3. For each pool, apply section 3 in order: members that do not fit, splitting or
   merging, underused members, and then the plan order of operations.
4. Write the report in the format of section 4. Recommend only what the data
   supports.
5. After approval, make exactly the approved change, the smallest one that works:
   a weight before a membership change, a schedule before a permanent weight, and
   an adjustment before a config edit for a temporary fact. Then re-run
   `route_stats` after enough time has passed. A weekday pattern needs at least a
   day, and a pattern across days needs at least a week.

## 3. Decision rules

Minimum evidence:

- 20 attempts before judging a member's latency, speed or reliability.
- 30 new-session draws before judging a weight.
- 3 days of history before judging a time-of-day pattern.
- 100 attempts in a pool before splitting or merging it.

Below these, say "not enough data yet" and name the number you need.

### 3.1 A member that does not fit its pool

Read the pool's purpose from its name, the categories that use it, and what the
user says. Compare each member with the pool's median member:

- Slow to answer: first output above 2.5 times the pool median.
- Slow to stream: tokens per second below half the pool median.
- Unreliable: failure rate of 20% or more. At 50% or more it is broken.
- Undersized: failures such as `ContextLengthExceeded` on a member, while the
  pool's `inputTokens` p90 is well above that member's context.
- Too expensive for the pool's purpose: only if the user states the prices.

Recommend moving a member only when two signals agree and the evidence meets the
minimums. A single bad hour is not evidence: look at `predictions` first. Route
data cannot measure answer quality. If the question is whether the answers are
good enough, ask the user. If no pool fits the member, propose a new pool rather
than forcing a fit.

### 3.2 Splitting a pool

Split only for one of these:

- Two request sizes behaving differently. `inputTokens` p90 is at least 4 times
  p50, and the failures or slow answers sit on the large requests. Propose a
  small-input pool and a large-input pool.
- Two categories sending different kinds of work to one pool, whose best members
  differ on the user's account or on the data. Route data cannot separate the
  categories, so say that. Propose the new pool and the category remap.

Do not split for one category, or below 100 attempts.

### 3.3 Merging or retiring a pool

Propose a merge when two pools have the same members or at least 80% overlap, and
the same categories use them. Propose retiring a pool when it has fewer than 20
attempts in 7 days and no category uses it. Retire only after the user confirms.

### 3.4 Underused members

Only in `weighted` and `round-robin` pools, compare `takeRate` with
`expectedShare`, over at least 30 draws:

- Underused: `takeRate` below half of `expectedShare`, and exclusions on fewer than
  20% of its offers. Its weight is too low for what it can take. Raise it by 1.5
  to 2 times, or add a time-bound schedule.
- Mostly excluded: this is a health or budget problem, not a weight problem.
  Read its errors, its cooldown and its budget.

In `ordered` pools a member behind a healthy first target is idle by design, so
do not call it underused. Look at it only when the targets ahead of it fail often,
or when it is configured but absent from the history. In that case check the
spelling, an `until` that has passed, and whether its provider is disabled.

Never recommend dropping a provider for low traffic alone. Lower its weight first,
and let a window pass before anything else.

### 3.5 Plans and quota: order of operations

For each provider that matters, gather: the plan, its cost (flat fee or metered),
the quota unit and window, what remains now (from `rateLimit` or the user), its
reset time or expiry date, and any promotion. Then compute:

- Burn rate per day: its attempts (or tokens) over the last 7 days, divided by the
  days of data.
- Days left: until the next reset, or until expiry if that comes first.
- Projected use: burn rate times days left.
- Headroom: remaining minus projected use.

Order the actions by time:

1. Expiring with headroom ("use it or lose it"): raise its weight now, with a
   `route_adjust` whose `hours` reach the expiry, or with a schedule that ends at
   expiry. Taper before expiry if the headroom shrinks.
2. A refilling window with headroom (daily or hourly): a schedule that raises its
   weight in the hours before the reset.
3. Projected to run out before its reset: skip the non-essential traffic with
   `route_adjust` until the reset time, and keep the target only for categories
   that need it.
4. A flat fee with headroom and no expiry: prefer it over metered members of the
   same pool.
5. Metered members: the lowest weight, fallback only, unless the flat plans have no
   headroom.

Present a timeline (now, next reset, expiry) with the change at each step. Mark
every number that came from the user, or from a single reading, as an estimate.

## 4. Report

Lead with the three most valuable actions. Then:

- **Evidence:** a table per pool with the window stated. Columns: member, attempts,
  failure rate, first output, tokens per second, take rate against expected share,
  exclusions, errors.
- **Findings:** each with the rule from section 3, the numbers behind it, a
  confidence (high, medium or low), and what would change the conclusion.
- **Proposed changes:** numbered. For each, give where it goes (the config path,
  the `route_adjust` arguments, or the OpenChamber setting), the exact snippet, the
  expected effect, when to check it, and how to undo it.
- **Needs you:** the questions only the user can answer: plan facts, prices,
  answer quality, and what a category is meant to cover.
- **Not measured:** what this review could not see.

Keep it short enough to read in a terminal. Label every measured fact and every
guess as such.

## 5. Plan facts table

Ask for these in one table. Leave blanks for anything unknown.

| provider | plan | cost | quota unit and window | remaining now | resets or expires | notes (promos, limits) |
| -------- | ---- | ---- | --------------------- | ------------- | ----------------- | ---------------------- |

## 6. Guardrails

- Read-only until the user approves a specific change. That covers `route_adjust`,
  `route_stats` with `apply: true`, and any edit to the OpenCode config,
  `routing.json`, or OpenChamber settings.
- Do not read or print credentials, tokens or auth files.
- Do not invent prices, plan limits, reset times or categories. Ask.
- Do not recommend from thin data. Name the minimum and what is missing.
- Do not react to one bad hour, one error, or one day of a weekly pattern.
- Prefer the smallest change: a weight before a membership change, a schedule
  before a permanent weight, and an adjustment before a config edit.
- Respect the user's choices. A pool they built for a reason stays unless the data
  clearly contradicts it. If it does, say so and let them decide.
