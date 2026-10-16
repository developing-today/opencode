# GitHub tools: troubleshooting and gh CLI fallbacks

Load this when a `github` tool fails and the error's hint did not fix it. Every tool has a `gh` equivalent below, so
the work can continue while the cause is fixed. Report the original failure to the user if it needs their action
(signing in, granting a scope, an admin setting).

## How the tools authenticate

- Token order: `GH_TOKEN` or `GITHUB_TOKEN` (github.com and `*.ghe.com`), `GH_ENTERPRISE_TOKEN` or
  `GITHUB_ENTERPRISE_TOKEN` (GitHub Enterprise Server), then `gh auth token --hostname <host>`.
- The host comes from the working directory's git remote (the remote picked by `gh repo set-default`, then the branch's
  push remote, then `origin`), or from `GH_HOST` when a `repo` is passed without one.
- `context` reports which source supplied the token (`auth`).

## Diagnose

| Symptom (error kind)               | Check                                                                             | Fix                                                                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth` / 401                       | `gh auth status`                                                                  | `gh auth login --hostname <host>`; an expired `GH_TOKEN` in the environment overrides gh's login, so unset it                                                              |
| `forbidden` / 403                  | The error lists accepted and granted scopes. `gh auth status` shows scopes        | `gh auth refresh --hostname <host> --scopes repo,read:org,workflow,security_events`; fine-grained tokens need the matching repository permission; some settings need admin |
| `not_found` / 404                  | Owner/name and number; private repositories answer 404 to accounts without access | Pass `repo` explicitly; confirm access with `gh repo view <owner>/<name>`                                                                                                  |
| `rate_limited`                     | `gh api rate_limit`                                                               | Wait for the reset in the error; batch work (one `feedback` call instead of many)                                                                                          |
| `network`                          | `gh api /meta`                                                                    | Proxy, VPN or offline; retry                                                                                                                                               |
| `unsupported`                      | Host type                                                                         | Uploads and some Copilot features are unavailable on GitHub Enterprise Server                                                                                              |
| Code scanning alerts "unavailable" | Code scanning enabled? Token has `security_events`?                               | Enable it, or refresh scopes                                                                                                                                               |
| Copilot review never starts        | `copilot` shows `requested` + `stuck`                                             | Copilot code review must be enabled for the repository or account; re-request with `copilot` `force`, or ask the user to request it in the web UI                          |

The tools come from the built-in `opencode.github` plugin. Turn it off with `"plugins": ["-opencode.github"]`, or
limit single tools with permissions such as `"permission": { "github_pr_merge": "ask" }`.

## gh equivalents

Review loop (replace OWNER, REPO, N):

```sh
gh pr view N --json number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup
gh api graphql -F owner=OWNER -F name=REPO -F n=N -f query='
query($owner:String!,$name:String!,$n:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$n){
  reviewThreads(first:50,after:$cursor){pageInfo{hasNextPage endCursor}
    nodes{id isResolved isOutdated path line comments(first:20){nodes{author{login} body url}}}}}}}'
# Paginate with -F cursor=<endCursor> until hasNextPage is false; threads are oldest first.
gh api "repos/OWNER/REPO/pulls/N/reviews?per_page=100"            # Copilot's review bodies (verdict, body-only findings)
gh api "repos/OWNER/REPO/code-scanning/alerts?pr=N&state=open"
gh api "repos/OWNER/REPO/issues/N/comments?per_page=100"
```

Reply, resolve, dismiss:

```sh
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url pullRequestReview{id state}}}}' -f t=PRRT_x -f b='Fixed in abc1234.'
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t=PRRT_x
# If the reply's pullRequestReview.state is PENDING, publish it:
gh api graphql -f query='mutation($r:ID!){submitPullRequestReview(input:{pullRequestReviewId:$r,event:COMMENT}){pullRequestReview{state}}}' -f r=PRR_x
gh api -X PATCH repos/OWNER/REPO/code-scanning/alerts/5 -f state=dismissed -f dismissed_reason='false positive' -f dismissed_comment='why'
gh api graphql -f query='mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:RESOLVED}){minimizedComment{isMinimized}}}' -f id=IC_x
```

Dismissal reasons are `false positive`, `won't fix` and `used in tests`; a fixed alert closes when analysis of the fix
runs. Repositories with delegated dismissal turn a dismissal into a request that someone must approve.

Copilot review state and requests:

```sh
gh api "repos/OWNER/REPO/pulls/N/requested_reviewers"            # Copilot listed = requested or in progress
gh api "repos/OWNER/REPO/issues/N/timeline?per_page=100" --paginate --jq '.[] | select(.event|test("review_requested|copilot_work")) | {event, created_at, who: .requested_reviewer.login}'
gh pr edit N --add-reviewer @copilot                                # or:
gh api -X POST "repos/OWNER/REPO/pulls/N/requested_reviewers" -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
# Re-request a stuck review: DELETE the same request first, then POST again.
```

Copilot never approves. Its review body starts with a verdict (`Approval recommended`, `Changes recommended`,
`Needs a closer look`) and may hold findings with no thread under "Previously missed" or "Comments suppressed due to
low confidence"; read them from the review body.

Pull requests, issues, discussions:

```sh
gh pr list --search 'is:open author:@me' ; gh pr create --fill --draft ; gh pr edit N --add-label x ; gh pr ready N
gh pr merge N --squash --delete-branch ; gh pr merge N --auto --merge ; gh pr diff N --name-only
gh pr review N --approve | --request-changes -b 'why' | --comment -b 'note'
gh issue list --search 'label:bug' ; gh issue view N --comments ; gh issue create -t T -b B ; gh issue close N --reason 'not planned'
gh issue comment N -b 'text' --attach ./screenshot.png      # uploads the image (gh >= 2.99)
gh api graphql -f query='{repository(owner:"OWNER",name:"REPO"){discussions(first:20){nodes{number title url}}}}'
```

Actions and releases:

```sh
gh run list --branch B --limit 20 ; gh run view RUN --json jobs ; gh run view RUN --log-failed ; gh run view --job JOB --log
gh run rerun RUN --failed ; gh run cancel RUN ; gh workflow run ci.yml --ref B -f key=value ; gh run download RUN -n name -D dir
gh release list ; gh release view TAG ; gh release create TAG --generate-notes file1 ; gh release upload TAG file ; gh release download TAG -p '*.zip'
```

Search and history:

```sh
gh search code 'symbol repo:OWNER/REPO' ; gh search commits 'author:LOGIN org:ORG' ; gh search prs 'repo:OWNER/REPO is:merged'
gh api "repos/OWNER/REPO/commits?sha=main&author=LOGIN&per_page=100" ; gh api "repos/OWNER/REPO/compare/main...branch"
gh api "repos/OWNER/REPO/rules/branches/main"    # rules that apply to a branch, readable without admin
```

Uploads: `gh issue comment N --attach file.png` or `gh pr comment N --attach file.png`. Without a gh that has `--attach`,
commit the file to a dedicated branch and link `https://github.com/OWNER/REPO/blob/<sha>/<path>?raw=true`.
