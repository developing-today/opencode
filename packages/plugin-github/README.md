# GitHub tools

Built-in plugin `opencode.github`. It gives agents a `github` tool namespace for pull request review loops and the
rest of everyday GitHub work, through the account `gh` is signed in with.

## Turning it on and off

The plugin ships with OpenCode and is on by default. It is controlled like any other plugin and its tools like any
other tools:

```jsonc title="opencode.jsonc"
{
  // Turn the plugin off.
  "plugins": ["-opencode.github"],
  // Or keep it and limit single tools. Every tool's permission is github_<name>.
  "permission": {
    "github_pr_merge": "ask",
    "github_release_*": "deny",
  },
}
```

Writes (replies, merges, issues, releases, dispatches, uploads) also ask the `github_<name>` permission with the
repository as the resource, so `"github_respond": { "*": "allow", "github.com/acme/secret": "ask" }` works. Resources
are lower case, since GitHub names are case-insensitive, so write repository patterns in lower case.
Downloads into a directory you name, and local files read for uploads, use the same `edit`, `read` and
`external_directory` permissions as the file tools.

The tools live in the Code Mode catalog (`tools.github.<name>`). To list them on the provider's native tool list as
`github_<name>` instead, load the package with the plugin option `codemode: false`.

## Authentication

`GH_TOKEN` or `GITHUB_TOKEN` (`GH_ENTERPRISE_TOKEN` for GitHub Enterprise Server), otherwise `gh auth token`. The
host comes from the working directory's git remote, or `GH_HOST`. Failures explain the fix and name the hidden
`github` skill, which has troubleshooting steps and `gh` equivalents for every tool. The skill is not listed to agents
unless something fails.

## Tools

Review loop:

| Tool          | What it does                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`     | Repository, viewer and permissions, the current branch's pull request, preferences and review-loop guidance.                                                                                                                                |
| `pr`          | One-call status: checks, reviews, Copilot's state and verdict, unresolved counts, merge blockers and warnings.                                                                                                                              |
| `feedback`    | Every open item with a stable ID: review threads (Copilot, people, bots, with severity), findings that exist only in Copilot's review body (low confidence, previously missed), code scanning alerts, and comments and reviews from people. |
| `respond`     | Batch reply, resolve, reopen. Alerts are dismissed with a reason; replies to people get an automated-reply prefix; `{sha}` becomes the pushed head; optional follow-up issue per item.                                                      |
| `updates`     | What changed since the session last looked: new commits on the branch and on the target branch, reviews, comments, checks.                                                                                                                  |
| `copilot`     | Copilot's review state from reviews and timeline events, and requesting or re-requesting a review.                                                                                                                                          |
| `wait`        | Waits for the next Copilot review or for checks, in the background by default; the result, with the open items, arrives in the session as a message.                                                                                        |
| `preferences` | Persistent preferences per repository or global: review rounds, follow-up issue policy, reply prefix, auto-request, merge method, wait timeout, notes.                                                                                      |

Everyday work: `prs`, `pr_create`, `pr_update`, `pr_merge`, `pr_files`, `review`, `issues`, `issue`, `issue_create`,
`issue_update`, `comment`, `comment_update`, `discussions`, `discussion`, `discussion_create`, `discussion_update`,
`workflows`, `runs`, `run`, `logs`, `run_action`, `dispatch`, `artifacts`, `artifact_download`, `releases`,
`release_create`, `release_update`, `release_notes`, `release_asset`, `repo`, `search`, `commits`, `compare`, `repos`,
`upload` and `api`. `repo` is the read-only settings overview: features, merge options and default commit messages
(named as the settings page names them), release immutability, custom properties, security, Actions permissions,
CODEOWNERS and the default branch's rules.

Repository administration starts hidden (see [Showing and hiding tools](#showing-and-hiding-tools)):

| Section             | Tools                                           | What they do                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo_settings`     | `repo_update`                                   | Description, visibility, features, pull request policy, forking, template, sign-off, merge options and default commit messages, release immutability, topics, archiving. Reports settings GitHub accepted but ignored.  |
| `access`            | `collaborators`, `collaborator_update`          | Users with their roles, teams, pending invitations and custom repository roles; invite, change, remove, cancel invitations.                                                                                             |
| `properties`        | `properties`, `property_set`                    | Custom property values and the organization's property definitions; set or clear values.                                                                                                                                |
| `variables`         | `variables`, `variable_set`                     | Actions variables with values, at repository, environment and organization scope (including organization variables shared with the repository); create, update, delete.                                                 |
| `secrets`           | `secrets`, `secret_set`                         | Secret names only, at the same scopes, for Actions, Dependabot and Codespaces. Setting reads the value from `from_file` or `from_env` (or `value`), encrypts it through `gh secret set` on stdin, and never returns it. |
| `environments`      | `environments`, `environment_update`            | Deployment environments: reviewers, wait timer, admin bypass, deployment branch and tag patterns, variable and secret counts; create, update, delete.                                                                   |
| `rulesets`          | `rulesets`, `ruleset_update`                    | Repository and organization rulesets in full, and the rules that apply to a branch (readable without admin access); create, update, delete.                                                                             |
| `branch_protection` | `branch_protection`, `branch_protection_update` | Classic branch protection in full, with a pointer to rulesets when it is unavailable; replace or remove it.                                                                                                             |
| `tags`              | `tags`, `tag_update`                            | Tags with their commits; create lightweight or annotated tags, delete. Tag protection lives in rulesets.                                                                                                                |
| `actions_settings`  | `actions_settings`, `actions_settings_update`   | Allowed actions, default workflow permissions, retention, fork pull request approval, access from other repositories, OIDC subject claims, self-hosted runners.                                                         |
| `webhooks`          | `webhooks`, `webhook_update`                    | Webhooks and recent deliveries (secrets never shown); create, update, delete, ping, test, redeliver.                                                                                                                    |
| `pages`             | `pages`, `pages_update`                         | Pages source, build type, domain and the latest build; enable, update, disable, rebuild.                                                                                                                                |
| `deploy_keys`       | `deploy_keys`, `deploy_key_update`              | Deploy keys without their key material; add, delete.                                                                                                                                                                    |
| `autolinks`         | `autolinks`, `autolink_update`                  | Autolink references; create, delete.                                                                                                                                                                                    |
| `security`          | `security`, `security_update`                   | Advanced Security, secret scanning and push protection, Dependabot alerts and security updates, private vulnerability reporting, code scanning default setup, open alert counts; toggle each.                           |
| `alerts`            | `alerts`, `alert_update`                        | Repository-wide Dependabot, code scanning and secret scanning alerts (secret values never returned); dismiss, reopen, resolve.                                                                                          |
| `copilot_settings`  | `copilot_settings`, `copilot_settings_update`   | The repository's Copilot cloud agent configuration (read-only in the API), the organization's cloud agent policy, seats and content exclusion; change the organization settings.                                        |

Organization-level variables and secrets (Actions, Dependabot, Codespaces) are covered by `variables` and `secrets`
with `org`. Code review on push is a ruleset rule, so it is configured with `ruleset_update`.

### Showing and hiding tools

Three tools are always listed: `list_tools`, `enable` and `disable`. They keep rarely used tools out of the tool list
until a session needs them; they do not restrict anything (use permissions or plugin config for that).

```js
await tools.github.list_tools({}) // every section and tool, hidden ones summarized
await tools.github.enable({ patterns: ["dependabot", "secret*"] }) // sections, aliases and tools; * and ? wildcards
await tools.github.disable({ patterns: ["*_set", "*_update"] }) // hide writes
await tools.github.list_tools({ reset: true }) // back to the defaults
```

Patterns match tool names and section names with wildcards, and section aliases exactly (`admin`, `settings`,
`dependabot`, `protection`, `copilot`, …; `list_tools` shows them). Changes apply from the next step to every session
in the project: any directory, worktree or clone of the same repository (OpenCode's project ID), or the one directory
outside a repository. They survive restarts. To start with other defaults, set the `tools_enabled` and
`tools_disabled` preferences globally or per repository, for example
`preferences({ scope: "global", set: { tools_enabled: ["admin"] } })`.

Administrative writes follow the same permission defaults as every other tool. To be asked first:

```jsonc title="opencode.jsonc"
{
  "permission": {
    "github_*_set": "ask",
    "github_*_update": "ask",
  },
}
```

## Design notes

- The plugin uses only the public plugin API (`@opencode/plugin/effect`), so core changes are limited to listing it
  among the built-in plugins.
- Copilot never approves a pull request. Its review body carries a verdict (Approval recommended, Changes recommended,
  Needs a closer look), severities for its threads, and findings with no thread; `copilot.ts` parses the current and
  older formats.
- GitHub's answer to a review request does not list Copilot, and `requested_reviewers` stays empty while it works, so
  review progress comes from the timeline (`review_requested`, `copilot_work_started`, `copilot_work_finished*`).
- Findings with no thread to resolve record their handled state in a hidden marker in a pull request comment, so every
  session and machine agrees on what is still open.
- Checks that re-ran for the same commit count once; checks queued for over ten minutes are reported with the runner
  labels their job waits for, since a missing runner is the usual reason.
- A background `wait` is recorded in plugin storage until it settles, so a plugin reload or a server restart resumes it
  instead of dropping the session's notification. It survives transient network, server and rate-limit errors, joins an existing wait for the same pull
  request instead of polling twice, and leaves a just-pushed commit to a repository's review-on-push rule for a minute
  before requesting a review itself.

## Tests

```sh
bun test --timeout 30000   # from packages/plugin-github
```

GitHub is faked in process (`test/fixture.ts`); nothing reaches the network. `packages/core/test/plugin-github.test.ts`
checks the built-in registration, disabling it through plugin config, and Code Mode execution through the host.
