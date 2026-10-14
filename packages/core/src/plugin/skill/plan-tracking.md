<!--
  Built-in skill. Name and description are registered in code at
  packages/core/src/plugin/skill.ts. The body below becomes the skill's
  content.
-->

# Plan Tracking

How to keep the user's plan records current, how to find the details that are
missing, and how to learn what the user expects from each plan from the notes they
give you. The records live in the plan store, read and written with `plan_info`.

## What the store holds

- Plans: one per subscription, credit balance or metered account. Fields: `id`,
  `providerID` (the OpenCode provider id), `label`, `plan` (the provider's name for
  it), `coverage` (`subscription`, `credits`, `metered`, `free` or `trial`), `fee`
  (`amount`, `currency`, `period`, `renewsOn`), `quotas`, `expiresOn`, `status`
  (`active`, `expired`, `cancelled` or `unknown`), `verifiedAt`, `verifiedFrom`,
  `howToCheck`, and `details`.
- Quota windows, in a plan's `quotas`: `name`, `unit` (`requests`, `messages`,
  `tokens`, `usd`, `percent` or `other`), `limit`, `windowHours` (how long the window
  is, rolling), `resetRule` (for example "rolling", "daily 00:00 UTC", "monthly on the
  14th") and `resetAt` (the next known reset).
- Model tiers: `cheap`, `standard` or `frontier`, per `provider/model`, with
  `coveredBy` (the plan ids that cover it). `cheap` describes models with negligible
  per-token costs or high-throughput fast models. `standard` covers everyday balanced
  engineering workhorses. `frontier` covers maximum-capability, heavy reasoning, or
  expensive frontier models. Models covered by an active subscription plan have
  marginal per-token cost zero while within quota limits.
- Pool purposes: a pool's `tier` and a `purpose` in words.
- Notes: dated, append-only, each with a `kind` (`experience`, `expectation`,
  `plan-change`, `correction` or `other`), and optionally the provider, plan, model
  or pool they are about.

Nothing is removed. A plan that ends is marked `expired` or `cancelled`.

## Finding current details

When a detail is missing or older than 30 days, these are the places to look, in
order:

1. OpenChamber, Settings → Usage: the windows and reset times the provider reports
   for accounts with saved credentials. This is the most current number you can read.
2. The provider's billing or usage page: the plan name, the included quota, the
   renewal date and any credit balance or expiry.
3. A receipt or a renewal email: the fee, the currency, the period and the date.
4. For OpenCode Zen and OpenCode Go, the console at opencode.ai/console shows billing
   and usage status.

Then ask the user for what remains. Ask only for the missing or stale fields, in one
short list. Never guess a limit, a reset time or a price. If a number is not
available, record what is known, leave the rest empty, and say so.

## Recording

- Use `plan_info` `upsert` for a plan's facts. Set `verifiedAt` to today's date and
  `verifiedFrom` to where the figure came from ("user", "Settings → Usage",
  "billing page", "receipt").
- Use `tier` for a model's tier and what covers it. Use `pool` for a pool's purpose
  and tier.
- Use `note` for anything the user says that is not a fact to store: an experience,
  an expectation, a correction. Store the user's words as they said them. A note is
  never rewritten, so a later correction is a new note with kind `correction`.
- Show the user what you recorded, in one line each, and ask if anything is wrong.

## Keeping it current

- Check the plans at least monthly, and at each renewal or plan change.
- Re-check a plan before you base a recommendation on it, once it is 30 days old.
- When the user says they ran out, or that they had quota left over, record a note
  of kind `experience` linked to the plan or provider, and ask the one question that
  would make it useful: when did it happen, and what were they working on.

## Learning what the user expects

The notes are how the user's expectations reach the review. Read them before you
recommend a change.

- An `experience` such as "ran out of Claude too fast on Tuesday" is evidence about
  a window's real size. Compare it with the usage the history shows for that window
  before you change anything. One note is not a fact.
- An `expectation` such as "I always have GPT left over at month end" is a priority:
  it says where spare quota should go. Treat it as the user's preference, and
  quote it when you explain a recommendation based on it.
- A `plan-change` updates what the plan record should say. Update the record too,
  with `upsert`, and keep the note.
- A `correction` overrides what an earlier note or record said. Follow the newest
  one, and say that you did.

When a note and the history disagree, show both and ask. Do not pick the one that
suits the recommendation.
