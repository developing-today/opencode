# Subsession Model Governance — Design

Date: 2026-10-25. Status: shaped, in implementation.
Source of requirements: Drew's subsession-governance spec, 2026-10-25 (the eight points in "Spec mapping" below).

## Summary

A session tree gets one enforceable answer to "which models may this subtree run".
Restrictions come from three layers — agent definitions, per-session policy, and the
explicit choice made when a child is launched — and compose by intersection as they
filter down the tree: a descendant can only narrow what its ancestors allow, never
widen it. Enforcement lives in one place, child-session creation in Core, so the
Task tool, the HTTP API, commands that run as subagents, and forks all get the same
answer. Agent definitions also gain a `max_depth`, and the existing depth check is
generalized so the effective cap for a subtree is the smallest of the global limit
and, for every ancestor, that ancestor's depth plus its own agent's max depth.

Two spec points meet existing architecture head-on and are resolved explicitly
below rather than dropped: route-named model choices (§7) and session import (§6.4).

## Current state (verified in code)

- Sessions carry `parentID`, `agent`, and `model` (`packages/schema/src/session.ts`,
  `Session.Info`). The HTTP API has `POST /api/session`, `/{id}/fork`, `/{id}/agent`,
  `/{id}/model`, and a `PATCH /{id}` update (`packages/protocol/src/groups/session.ts`).
- Child sessions are created through exactly one Core path: `Session.create` with a
  `parentID` (`packages/core/src/session.ts`). It loads the parent fresh from the
  store at creation time. Forks publish `session.forked` and the projector copies the
  source session's `agent` and `model` (`packages/core/src/session/projector.ts`).
- The subagent (Task) tool (`packages/core/src/tool/plugin/subagent.ts`) already
  accepts a `model` parameter, resolves aliases, and computes the child model as
  explicit choice, then the agent definition's model, then the parent session's
  model. Its parameter description currently says "NEVER set this unless the user
  explicitly asks", which the spec supersedes (§8).
- Agent definitions live in config (`ConfigAgent.Info`,
  `packages/schema/src/config/agent.ts`): one optional `model`, mode, steps,
  permissions. The config agent plugin (`packages/core/src/config/plugin/agent.ts`)
  copies the configured model onto the resolved `Agent.Info`
  (`packages/schema/src/agent.ts`). Nothing else about models is carried.
- Depth is enforced by `SubagentDepth.assertWithinLimit`
  (`packages/core/src/session/subagent-depth.ts`) from the single global
  `experimental.subagent_depth` (default 5), called by the subagent tool and by
  commands that run as subagents (`packages/core/src/config/plugin/command.ts`).
  Its root check runs before the ancestor walk, so a limit of 0 already disables
  subagents from a top-level session; the bug in issue #89 is fixed in current
  `main` and must not regress.
- Model routes (`experimental.model_routes`) are request-time failover sets
  installed by the model-routes config plugin. A session's stored model is always
  a concrete `Model.Ref`; routes are chosen by request hooks, never stored as a
  session model. See §7 for what that means for the spec.

## Spec mapping

| # | Spec point | Where it lands |
| - | ---------- | -------------- |
| 1 | A primary session sets allowed subsession models, at creation or live; changes apply immediately to later launches by the session or its descendants | `Session.Info.subagentPolicy`, set at create, replaced live by `setSubagentPolicy`; enforcement reads current projected state at child creation (§5, §6) |
| 2 | OpenChamber UI checkbox model picker on the session | OpenChamber stage; contract in §10 |
| 3 | Filter-down inheritance by intersection (DeepSeek/Haiku example) | Effective-set computation (§4), worked example §4.3 |
| 4 | Agent definition `model` is a default; a definition's allowed list can lock it; overrides must be explicit (force flag or per-agent session override) | Config + resolved-agent fields (§3.1, §3.2); override rules §4.2 |
| 5 | The Task tool lets any agent set the task's model, including a route or `auto` | Tool input changes (§8); route/`auto` resolution §7 |
| 6 | Per-agent default model, allowed, excluded, allowed-subagent, excluded-subagent lists | §3.1, §3.2 |
| 7 | Tooling prompts encourage subagents and say subagents can spawn their own | §8 |
| 8 | Per-agent max depth; effective cap = min(global, depth + own max depth); the depth-1 / max-2 / global-5 case caps at 3 | §9, with the example as a test |

## 3. Data model

### 3.0 Model selectors

Allowed and excluded lists hold *selectors*, defined once in
`packages/schema/src/model.ts` as `Model.Selector`: a string in `Model.Ref`
syntax with one extension — the model segment may be `*`.

- `provider/model` matches that model with any variant.
- `provider/model#variant` matches exactly that variant.
- `provider/*` matches every model of that provider.

`Model.Selector` carries statics: `matches(selector, ref)` and
`intersect(a, b)` (§4.1). One canonical type is used by config, resolved agents,
session policy, and errors, per the schema package's one-contract rule.

### 3.1 Agent definitions (config)

`ConfigAgent.Info` (`packages/schema/src/config/agent.ts`) gains five optional
fields, snake_case like its siblings. Lists are arrays of `Model.Selector`
(spelled in config as plain strings):

- `models` — models this agent's own sessions may run.
- `excluded_models` — models this agent's own sessions may never run.
- `subagent_models` — models this agent's direct subagents may run.
- `subagent_excluded_models` — models this agent's direct subagents may never run.
- `max_depth` — `NonNegativeInt`; deepest subtree this agent may root (§9).

The existing `model` stays the default. A definition whose `models` list contains
only its default model is locked to that model; that is the intended reading of
spec point 4, not a special case.

Legacy (v1) config normalization (`packages/core/src/config/normalize.ts`) passes
unknown agent keys through its diagnostics path the way it does for other
unsupported keys; the new keys are current-config only.

### 3.2 Resolved agents

`Agent.Info` (`packages/schema/src/agent.ts`) gains the resolved mirrors, all
optional: `models`, `excludedModels`, `subagentModels`, `subagentExcludedModels`
(arrays of `Model.Selector`), and `maxDepth`. The config agent plugin's existing
transform, which already copies `item.model` onto the resolved agent, copies these
the same way, so markdown-defined and config-defined agents behave identically.
Plugin-registered agents that never pass through config carry none of these
fields and are treated as unrestricted by the definition layer; session policy
still governs them.

### 3.3 Session policy

`Session.Info` gains one optional field, `subagentPolicy`:

```ts
Session.SubagentPolicy = {
  models?: Model.Selector[]          // allowed for this session's descendants
  excludedModels?: Model.Selector[]  // never allowed for descendants
  agentOverrides?: { [agentID: string]: Session.AgentOverride }
}
Session.AgentOverride = {
  model?: Model.Ref                  // replaces the definition's default
  models?: Model.Selector[]
  excludedModels?: Model.Selector[]
  subagentModels?: Model.Selector[]
  subagentExcludedModels?: Model.Selector[]
  force?: boolean                    // override replaces definition lists (§4.2)
}
```

The policy is the session's own declaration for its subtree. It is stored as a new
nullable JSON column `subagent_policy` on `session_v2` (migration generated with
the core package's `bun run migration` script), written by the projector from
`session.created`, replaced wholesale by a new durable event
`session.subagent-policy.updated` (full replacement, mirroring
`session.metadata.updated` and `session.permissions`), and copied from the source
session's row on fork, the way `agent` and `model` already are. Replacing the
whole struct on update keeps the fold trivial: the latest event is the policy.

The event is a current contract event: it joins the durable event manifest and
the Protocol event classification as `current`.

## 4. The effective allowed set

Enforcement is one function in a new Core module,
`packages/core/src/session/model-governance.ts`, written in the decoupled style of
`subagent-depth.ts`: it takes a session getter and the config entries, so every
caller enforces identically. It answers one question — may this child, of this
parent, running this agent, run this model — and fails with a typed
`ModelGovernance.DeniedError` whose message names the model, the effective allowed
set, and the layer that bound it.

### 4.1 Selector algebra

- `matches(selector, ref)` per §3.0.
- The intersection of two selector lists keeps, for each pair that overlaps, the
  narrower selector: equal selectors keep one copy; `provider/*` against any
  same-provider selector yields that selector; `provider/model` against
  `provider/model#v` yields `provider/model#v`. Pairs that do not overlap yield
  nothing. Intersecting with an absent list is the identity; an empty result
  means nothing is allowed.

### 4.2 Composition, in order

For a child of parent P, with child agent A and would-be model M:

1. **Subtree filter (hard).** Walk P's ancestry (P, its parent, and so on; cycle
   guard and missing-parent failure copied from the depth walk). Every ancestor's
   `subagentPolicy.models` intersects into the allowed set; every
   `subagentPolicy.excludedModels` unions into the excluded set. No override at
   any level replaces this layer — that is spec point 3 stated as a rule.
2. **Launching agent's subagent lists.** P's agent definition contributes
   `subagentModels` / `subagentExcludedModels`. These bind the children P
   launches; deeper descendants are bound at their own launch by their own
   parent's definition, plus layer 1 all the way down.
3. **Child agent's own lists, with explicit overrides applied.** A's definition
   contributes `models` / `excludedModels`. Overrides come from two explicit
   sources: P's `subagentPolicy.agentOverrides[A]`, and a per-call override from
   the launching tool (the Task tool's `model` and `force`, §8). An override's
   `model` replaces the definition's default outright — naming a model is the
   explicit act. Its lists behave by `force`:
   - Without `force`, override lists *intersect* the definition's lists: an
     override can narrow a definition, never widen it.
   - With `force: true`, override lists *replace* the definition's lists.
   Either way the result still passes through layers 1 and 2.
4. **The check.** M must match the final allowed set when one exists, and must
   match no excluded selector. M is the model the child will actually run:
   explicit choice, then the (possibly overridden) agent default, then P's
   model — the same chain the subagent tool already computes. When a creation
   call supplies no model and no agent default exists, the parent's model is
   what gets checked, because that is what the child inherits.

### 4.3 Worked example (spec point 3, becomes a test)

Primary session policy allows `deepseek/*` and `anthropic/claude-haiku-5-5`
("DeepSeek or Haiku"). Its child sets its own policy to `anthropic/claude-opus-5-5`
and `anthropic/claude-haiku-5-5` ("Opus or Haiku"). A grandchild's effective
allowed set is the intersection over both policies: only
`anthropic/claude-haiku-5-5`. Opus matches nothing in the primary's list; DeepSeek
matches nothing in the child's. A grandchild launch on Opus fails with the
DeniedError naming the single allowed model.

### 4.4 Why the definition layer is not the subtree filter

Spec point 6 says Reasoner can declare *its subagents* may only use Haiku.
Layer 2 applies that at Reasoner's launches. It is not applied again to
grandchildren, because the grandchild's launch is governed by its own parent's
definition and by every ancestor's session policy; if Reasoner's restriction
must bind the whole subtree, the session running Reasoner sets it as session
policy, where layer 1 makes it hereditary. The two mechanisms are deliberately
different in reach: definition lists are per-launch, session policy is per-subtree.

## 5. Dynamic updates (spec point 1)

`Session.setSubagentPolicy({ sessionID, subagentPolicy })` joins the facade next
to `setMetadata` and `setPermissions`, implemented on the ID-bound handle the way
`switchModel` is. It publishes `session.subagent-policy.updated`; the projector
replaces the stored policy.

Propagation needs no push and no cache invalidation, and this is verified from
the current code rather than assumed: `Session.create` loads the parent from the
store at creation time, and the governance walk loads every ancestor the same
way, so a child created after an update is checked against the updated policies
of all its ancestors. Sessions already running keep their model — the spec
applies changes to subsessions *started* after the change — but a running child's
later `switchModel` is checked against the current effective set (§6.3), so a
tightened policy cannot be escaped by switching.

The HTTP surface is the existing `PATCH /api/session/:sessionID` ("Update mutable
session properties"), extended with an optional `subagentPolicy` payload field,
plus the same optional field on `POST /api/session` so a primary session can be
created with its policy in place. After the Protocol change, run
`bun run generate` from `packages/client`; generated files are never edited by hand.

## 6. Enforcement points

### 6.1 `Session.create` — the choke point

When `parentID` is present, `create` runs the governance check before publishing
`session.created`, using the parent it already loaded. A denied creation fails
with the DeniedError and creates nothing. This one placement covers the Task
tool, commands that run as subagents, the HTTP API, and OpenChamber, because all
of them create children through this function.

One wiring note: the governance module needs agent definitions. It reads them
from config entries — the same source `SubagentDepth` already depends on — and
the facade obtains them from the created session's Location services, the way
other Location-scoped lookups are reached from the facade. The module itself
stays pure over an injected getter and entries, so tests drive it directly.

### 6.2 Fork

`Session.fork` creates a child whose parent is the source session and whose model
is copied from it. Before publishing `session.forked`, fork runs the same check
with the source as parent and the copied model as M. A source session whose own
model falls outside its declared subsession policy therefore cannot be forked
until the policy or the model changes; the error says so. Fork does not gain a
depth check — it has none today and the spec does not ask for one.

### 6.3 `switchModel` on a child session

When the target session has a `parentID`, the facade's `switchModel` checks the
new model against the effective set computed from its ancestors and its agent
definition before delegating. Top-level sessions are unchecked: governance
constrains subsessions, not a user's own session.

### 6.4 Exempt paths, stated openly

- Session *import* (`/api/experimental/session/import`) restores externally
  produced trees and does not run the check; blocking a restore because a
  recorded model is now restricted would strand backups. Imported sessions are
  still governed from their next child creation or model switch onward.
- Continuing an existing child through the Task tool with a new agent or model
  goes through `switchAgent` / `switchModel`, so §6.3 covers it.

## 7. Routes and `auto` (spec point 5, conflict resolved)

The spec asks the Task tool to accept a model, an OpenCode route, or `auto`.
In this codebase a stored model is always a concrete `Model.Ref`; routes are
request-time failover overlays chosen by hooks, with no session-level
representation, and `auto` has no existing meaning. Inventing a route variant of
`Model.Ref` would touch the runner, the protocol, and every client for a
selection the request layer already makes per call. The design therefore maps
the spec's three forms onto what exists, and says so:

- A concrete ref (`provider/model[#variant]`) — as today, after alias resolution.
- A name — resolved through the existing alias table (`ModelAlias.resolve`),
  which is how fleet config already names models and route entry points; if the
  resolved name is a configured route, the check requires *every* target of the
  route to pass the effective set, because a route may fail over to any of them.
- `auto` — the literal string, meaning "no explicit choice": the default chain
  (agent default, then inherited) decides, and that model is what gets checked.

If a future change gives routes a session-level representation, the governance
check already knows how to judge one (all targets must pass), so nothing here
has to be revisited.

## 8. Task tool and prompts (spec points 5 and 7)

`packages/core/src/tool/plugin/subagent.ts`:

- The `model` parameter description loses the "NEVER set this" wording. New
  wording: set it when the user asks for a model or the task clearly warrants a
  different one; the value is a model ref, a configured alias or route name, or
  `auto` for the default chain; look unfamiliar IDs up with the models tool.
- New optional `force` boolean: "Set true only to explicitly override the agent
  definition's model lists for this call. Ancestor session policies still apply
  and cannot be forced past." The tool passes it into creation as the per-call
  override (§4.2); the resolved explicit model already acts as the override's
  `model`.
- The tool description gains two lines: subagents are the default way to
  delegate non-trivial work, and a subagent may itself launch subagents —
  subject to the depth limit and to model governance, whose failures name the
  allowed models so the caller can pick a permitted one and retry.
- The session-context hook that lists available subagents stays as is; the
  encouragement belongs in the tool description every agent sees.

## 9. Depth (spec point 8)

`SubagentDepth.assertWithinLimit` keeps its signature and its callers. The walk
is restructured to collect the ancestor chain first (same cycle guard, same
missing-parent failure), then compute:

```
cap = experimental.subagent_depth ?? 5
for each ancestor A of the launching session, including itself:
    if A's agent definition sets max_depth m: cap = min(cap, depth(A) + m)
fail when depth(launching) + 1 > cap
```

where `depth` counts edges below the top-level session (top-level = 0). With no
`max_depth` anywhere this reduces to the current check exactly, including the
root case: limit 0 makes even a top-level launch fail (issue #89 stays fixed).
Error messages keep the existing global wording; a per-agent cap that binds
produces a message naming the agent, its `max_depth`, and the resulting cap.

Worked example (spec point 8, becomes a test): global 5; a session at depth 1
whose agent sets `max_depth: 2` contributes cap 1 + 2 = 3. Its children (depth 2)
and grandchildren (depth 3) launch fine; a launch from depth 3 would create
depth 4 and fails. The subtree's ceiling is 3, not 5.

Note the deliberate reading: an agent's `max_depth` is a property of the
*launching* session's agent, re-evaluated at every level from the definitions,
not a value copied into children at creation. A subtree's ceiling is therefore
the minimum over the caps its ancestors' agents declare, which is what
"filter down" means for depth.

## 10. OpenChamber contract (stage 3)

OpenChamber consumes sessions through its control surface
(`packages/web/server/lib/openchamber-control`) and the generated client types.

- The control session create/update calls forward `subagentPolicy` in the
  session create body and in the `PATCH` update body unchanged. The web server
  is JavaScript and forwards JSON; no server-side schema work is needed beyond
  passing the field through where bodies are constructed.
- The UI adds a "Subsession models" picker to the session view, beside the
  existing model picker: a checkbox list of the models from the same catalog
  the model picker already loads. Checked values are exact model refs
  (`provider/model`); wildcards and routes stay available through config and
  the API, and the picker shows an existing wildcard policy entry as a
  read-only row rather than silently dropping it. Toggling a checkbox PATCHes
  the session with the updated `subagentPolicy.models`, preserving
  `excludedModels` and `agentOverrides`; the change is live for the next child
  launch (§5).
- The same selection is offered when creating a session wherever the create
  flow already offers a model, sent as `subagentPolicy` on create.
- UI types: the published `@opencode/client` will not know `subagentPolicy`
  until the regenerated client ships. The UI stage defines the field at its
  API boundary (a local extension of the session info type where the update
  call is made) instead of editing generated code, and notes the follow-up.

## 11. Tests

Core (`packages/core`, run from the package directory, per `.opencode/skills/unit-tests`):

- `session/model-governance.test.ts`: selector matching (exact, variant,
  wildcard); intersection narrowing incl. the provider-wildcard cases; the
  §4.3 Haiku example end to end; excluded beats allowed; definition lock
  (list containing only the default); override without force cannot widen,
  with force replaces; ancestor policy cannot be forced past; route targets
  all must pass; `auto` follows the default chain.
- `session/subagent-depth.test.ts` (extend or add beside the existing tests):
  the §9 example (global 5, depth-1 launcher with max_depth 2 — depth 3
  launches, depth 4 fails); `max_depth: 0` on a root agent disables launches;
  regression: global 0 still disables from a top-level session (#89);
  no-max-depth behavior unchanged.
- Tool tests beside `test/tool-subagent.test.ts`: `force` reaches creation;
  a denied model returns the governance error with the allowed set in the
  message; the description text updates are covered by the existing tool
  snapshot patterns if any exist.
- Session tests: create with a parent and a forbidden model creates nothing;
  fork of a session whose model is outside its own subsession policy fails;
  `setSubagentPolicy` then a child launch sees the new policy without any
  restart (dynamic propagation); `switchModel` on a child to a forbidden
  model fails, on a top-level session succeeds.
- Config tests: the five new agent fields decode from config documents and
  markdown frontmatter; the resolved `Agent.Info` carries them.
- Schema tests: `Model.Selector` pattern accepts refs and wildcards and
  rejects bare names; new public identifiers are unique
  (`Session.SubagentPolicy`, `Session.AgentOverride`, `Model.Selector`).

OpenChamber: focused tests for the control passthrough and the picker
component per that repo's change-discipline matrix, plus type-check and lint
on the changed packages.

## 12. Risks and non-goals

- Enforcement reads config-defined agent definitions. An agent whose
  definition is supplied only by a plugin binary (no config entry) has no
  definition-layer lists; layers 1 and 2 still apply where their sources
  exist. Documented here so it is a known boundary, not a surprise.
- The governance walk loads ancestors per creation, like the depth walk
  already does. No caching is added; creation is not a hot path.
- No TUI surface is built in this stage. The TUI consumes the same API and
  types; a picker there is a follow-up, not a silent omission — the spec
  asks for the OpenChamber UI.
- Existing sessions have no `subagent_policy` (null column) and behave
  exactly as today until a policy is set.
