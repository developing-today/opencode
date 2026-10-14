<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Routing Usage

What the history records, what each figure means, and how to read `route_usage`.
Use it before you answer any question about what was used, what it cost, or how
much of a plan's quota is gone.

## What is recorded, and for how long

- Every request OpenCode makes to a provider is one attempt, kept with its session,
  the pool it went through, its provider and model, its tokens, its outcome, its
  first-output time and its cost. Every routing selection is kept too: which targets
  were eligible, the weights used, who was left out and why, and who was chosen.
- Nothing in the history is deleted automatically. A longer window is always
  available. The history does not hold prompts or responses.
- Cost is recorded per request, from the model's catalog prices and the tokens the
  request used. Requests made before cost was recorded have no cost; treat their
  cost as unknown, not zero.
- Background requests (titles, summaries, compaction) are not always attributed to
  a pool or a cost. Say so when they matter to a question.

## The figures

- Requests: attempts, including failed ones and the cancelled leg of a hedged race.
  A hedged race counts two requests for one answer.
- Failures: attempts that ended in a failure or a timeout.
- Metered tokens: input, output and reasoning tokens together. This is the figure
  plans usually meter. Cache reads and writes are reported apart, because providers
  price them differently.
- Cost (USD): from catalog prices. It is an estimate of what the provider charges,
  not the invoice.
- Sessions: the OpenCode session the requests belonged to. A session can use several
  pools and models; its totals include all of them.
- Pools per target: `used` (chosen at least once), `offered-not-chosen` (eligible
  but never chosen in the window), or `configured-not-reached` (listed in the pool
  but never eligible). The last usually means failover, a cooldown or budget, a
  disabled provider, or a typo in the config. Look at the pool's `route_stats` view
  before you conclude which.
- Percent of a plan window: for `plans`, the window's unit used in its last
  `windowHours`, over the limit the user recorded. For `sessions`, the share of that
  same limit that one session used, so a session's `used` shows how much of the
  window a piece of work took. Usage counts against every plan of the provider, so
  keep one plan record per provider, or say in notes which plan is which.
- Days: UTC days. A day that straddles the user's local midnight is split.

## Reading `route_usage`

- Start broad: `route_usage` with `hours: 168`. Then narrow with `provider`, `model`,
  `route` (one pool) or `session`.
- For "which pool used this provider": use `targets`. Each target lists its pools
  and their state. `route` narrows the offers to one pool.
- For "which sessions used the most": use `sessions`, sorted by last activity, with
  the tokens and cost of each. Raise `limit` for more than 20.
- For "how much of the window is gone": use `plans`. Each quota window shows used,
  limit, percent and the reset rule.
- For trends: use `days`. Compare like with like: a weekday against a weekday.

## What the history cannot show

- Which OpenChamber category a request came from. Pools are shared between
  categories in many setups, so a pool's numbers can mix categories. Say so.
- Answer quality. Latency, failures and cost are measured; whether an answer was
  good is not, unless the user says.
- A provider's own quota, when the provider reports nothing and the user has not
  recorded a limit. Then the percent is unknown, not zero.
- Anything before the history began. Say how far back the data goes when it matters.

## Answering

- Give the window, the figure and its unit, and what it is measured against.
- Mark estimates: a percent from a recorded limit, a cost from catalog prices.
- When two figures disagree, say which one you used and why.
