<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Routing Config

How to change what OpenCode shows and how routed models are chosen, with the exact
keys. Read this before you edit a config file. Change nothing until the user
approves the specific change.

## Where config lives

- Project settings: `opencode.jsonc` (or `opencode.json`) at the project root.
  Global settings: the OpenCode config directory, `~/.config/opencode/`. Project
  values override global ones. `opencode config` lists the files OpenCode reads.
- OpenCode reloads config files on change. A request already in progress keeps the
  settings it started with.
- JSONC allows comments and trailing commas. Keep both valid when you edit.
- OpenChamber's Auto categories are not in this file. They live in OpenChamber's
  `routing.json` (see routing-review, section 1).

## Providers: turn on or off

- Turn one off: `"disabled_providers": ["<providerID>"]`. Its models leave every
  picker, and pool targets that use it cannot be reached.
- Allow-list: `"enabled_providers": ["<providerID>", ...]` turns off every provider
  it does not name. Use it only when the user asks for an allow-list.
- The same thing as policies, in the top-level `policies` list:
  `{ "action": "provider.use", "resource": "<providerID>", "effect": "deny" }`, or
  `"allow"` to switch a denied provider back on. `experimental.policies` is the
  deprecated name for that list: it still loads, but write new rules in `policies`.
- In OpenChamber, Settings → Providers has an on/off control. `/connect` in OpenCode
  connects a provider. Never edit credential files by hand.

## Models: hide, show, add

Model entries sit under `providers`:

```jsonc
{
  "providers": {
    "<providerID>": {
      "models": {
        "<modelID>": { "disabled": true },
      },
    },
  },
}
```

- `disabled: true` hides the model from the picker and takes it out of routing.
- Show it again: set `"disabled": false`, or delete the key.
- Add a model the catalog does not list: a new key under `models` with `modelID`
  (the provider's real id), `name`, and `limit` (`context`, `output`).
- In OpenChamber, hiding a model from the model picker is a UI-only setting. OpenCode
  and the pools still use the model. The config key is what changes what routing
  can reach.

## Pools: define and change

A pool is `experimental.model_routes.<id>`. OpenCode and OpenChamber show it as the
model `opencode-route/<id>`.

```jsonc
{
  "experimental": {
    "model_routes": {
      "cheap-fast": {
        "targets": ["openai/gpt-6-luna", "github-copilot/gpt-6-luna"],
        "selection": "weighted",
        "weights": { "openai/gpt-6-luna": 3, "github-copilot/gpt-6-luna": 1 },
        "autonomy": "agent",
        "health": { "firstTokenTimeoutMs": 10000, "cooldownMs": 60000 },
        "budgets": { "openai/gpt-6-luna": { "requestsPerDay": 500, "softLimit": 0.9 } },
        "attempts": 1,
        "hedgeAfterMs": 8000,
      },
    },
  },
}
```

- `targets`: `"provider/model"`, `"provider/model#variant"`, or
  `{ "model": "provider/model", "defaultVariant", "variants", "until" }`. `until` is
  an epoch-millisecond time after which the target leaves the pool. A target can be
  another pool, written `"opencode-route/<id>"`. A `*` in a target stays inside that
  provider and is case-sensitive. `targets` is optional when a matching key below
  adds models.
- Matching keys pick models across every connected provider, ignoring case. A
  provider that is not connected contributes nothing until it is:
  - `include`: patterns that add models, e.g. `["*luna*", "anthropic/*haiku*"]`.
    `*` is any run of characters; a pattern with `/` is tested against
    `provider/model`, one without against the model id; `re:` starts a regular
    expression, unanchored unless it uses `^` or `$`.
  - `exclude`: patterns that remove models, including targets and the members of
    nested pools. `["*-5"]` drops `luna-5` and keeps `luna-5.5`.
  - `contains`, `notContains`: plain text found in the model id, or in
    `provider/model` when it has a `/`. `["haiku", "sonnet"]`.
  - `match`: one expression with `and`, `or`, `not` and parentheses, e.g.
    `"(*luna* or *haiku*) and not *mini*"`. Quote a term with spaces or parentheses:
    `"'re:gpt-(5|6)$' or *luna*"`. There is no `xor`.
  - An entry or term that is exactly another pool's id, or `opencode-route/<id>`,
    stands for that pool's models, without its weights or effort settings. A pool
    naming itself gets nothing from that name.
  - Order: targets first, then matched models in provider order, each model once;
    then the removals.
- Effort levels (variants):
  - `variants` on a target object remaps a level, `{ "xhigh": "high" }`; `false`
    makes the target sit that level out, `{ "max": false }`. A target that sits out
    a level is never used at it, not even as a last resort. On a nested pool's
    target object only `false` applies, and the whole nested pool sits that level
    out; a string remap, `defaultVariant` or `until` there is ignored and logged.
  - `variantRules`: `[{ "match": "*argon*", "map": { "xhigh": "high", "max": false } }]`.
    `match` takes a pattern, pool name or expression. Later rules override earlier
    ones per level; a target's own `variants` override every rule.
  - `levels`: `["low", "medium", "high"]` makes the pool offer exactly those. A
    target that cannot run one sits it out; a level no target can run is dropped
    and logged. Without `levels`, a level is offered when every target runs it or
    sits it out and at least one target runs it. Nested in another pool, a pool
    keeps its `levels`: its members sit out every other level.
  - A nested pool pinned as `opencode-route/<id>#<level>` runs only at that level
    and brings each member that has that variant, at that variant. A remap or rule
    applies to the levels of the pool that declares it, so those of the pinned pool
    and the pools nested in it decide only whether a member sits the pin out. Such a
    member is left out, and nothing else in the pinned pool brings it back. The
    others run at the pin at every level of the pools above, unless one of those
    sits them out of a level. A pool pinned at a level it does not declare adds
    nothing.
- `selection`: `ordered` (the default), `round-robin`, or `weighted`.
- `weights`: relative ratios keyed by target. A target not listed weighs 1. Models
  from matching keys are keyed by `provider/model` too.
- `autonomy`: `fixed`, `rules`, `adaptive`, `predictive`, or `agent`. Each level
  includes the ones before it. Every session gets `route_usage` whenever any pool
  exists, and gets `route_stats` and `route_adjust` once any pool is `agent` or has
  no `autonomy`, whatever model the session runs. `route_stats` reports on every
  pool, and a `route_adjust` adjustment applies to every pool that is not `fixed`.
- `health`, `budgets`, `attempts`, `hedgeAfterMs`: see routing-review, section 1.

A malformed pattern, regular expression or expression skips the whole pool, and a
pool with none of `targets`, `include`, `contains` and `match` is skipped too. A
schedule whose `when` cannot be read, or that has neither `factor` nor `weight`, is
skipped on its own, and an unknown key anywhere in a pool is ignored, as is a string
remap, `defaultVariant` or `until` on a nested pool's target object. Each gets a
config warning that names the key. Check the log after editing a pool.

Common changes:

- Change a member's share: edit its `weights` entry. Ordered pools rank failover by
  weight too, so a weight change there also changes the order.
- Add a member: append it to `targets`, or widen `include`, and give it a `weights`
  entry if it should not weigh 1.
- Remove a member for good: delete it from `targets` and `weights`, or add it to
  `exclude`. For a temporary removal, use `route_adjust` skip with `hours`, which
  ends on its own. A target's `until` does not fit: the target leaves only when the
  pools are next rebuilt after that time, such as on a config reload or a restart,
  and it stays out until the config changes.
- Keep a member out of one level: map that level to `false` in its `variants`, or in
  a `variantRules` entry that matches it.
- A new pool: add a new key under `model_routes`. Then point a category at
  `opencode-route/<id>` in OpenChamber (Settings → Routing).

## Time-of-day and temporary weights

- Inside one pool, `schedules` is a list. Each entry has `targets` (optional,
  wildcards allowed), `when`, and either `factor` (multiplies) or `weight` (replaces):

```jsonc
"schedules": [
  {
    "targets": ["deepseek/*"],
    "when": {
      "daysOfWeek": ["mon", "tue", "wed", "thu", "fri"],
      "start": "09:00",
      "end": "17:00",
      "timezone": "America/Chicago",
    },
    "factor": 0.5,
    "note": "peak hours",
  },
],
```

- Across pools: `experimental.model_route_schedules`, a list of entries with
  `providers`, `models`, `targets`, `routes` (all optional), `when`, and `factor` or
  `weight`.
- `when` fields: `daysOfWeek` (`mon`..`sun`, or 0 to 6), `daysOfMonth` (1 to 31, or
  -1 for the last day), `start` and `end` as `HH:mm` (`end` exclusive; a start after
  the end runs past midnight), `timezone` (IANA), and `from` and `until` (epoch ms).
  A day list that is empty or unset means every day.
- A temporary fact ("credits expire Friday") belongs in `route_adjust`, not in config.
  It needs approval. It expires on its own only when it has `hours`: one made with a
  recurring window and no `hours` stays in force until `route_adjust` removes it.

## Tuning and notes

```jsonc
{
  "experimental": {
    "model_route_tuning": {
      "enabled": true,
      "intervalMinutes": 15,
      "windowHours": 24,
      "notes": ["openai/gpt-6-luna: out of quota, back in 3 hours"],
    },
  },
}
```

- `enabled` (default false) turns on the automatic review of history, which lowers or
  skips targets. It lapses on its own; it does not rewrite config.
- `notes`: one line each as `match: text`, where `match` is part of provider/model.
  A text that states a return time skips the match until then.

## Applying a change

1. Read the current value and show the user the before and after.
2. Get approval for that specific change.
3. Edit only the keys the change needs. Keep the rest of the file as it was.
4. Read the file back and check each key name against this skill.
5. Verify. For a pool change, run `route_stats` with `route` set. For a visibility or
   provider change, say what should now be missing from the model picker. Routing
   patterns need at least a day of history before they show.
6. Tell the user how to undo it: the previous value, in one line.
