export * as GitHubRepo from "./repo.js"

import { Effect } from "effect"
import { GitHubClient } from "./client.js"
import type { GitHubProcess } from "./process.js"

export interface Ref {
  readonly host: string
  readonly owner: string
  readonly name: string
}

export interface Local extends Ref {
  readonly remote: string
  readonly branch?: string
  readonly head?: string
  /**
   * Where the current branch is pushed, which is where its pull request's head lives. It can differ from the selected
   * repository (a fork when `gh repo set-default` picks the upstream) and from `branch` (push.default=upstream).
   */
  readonly push?: Ref & { readonly remote: string; readonly branch: string }
}

export const slug = (repo: Ref) => `${repo.owner}/${repo.name}`

/** Parses `owner/repo`, `host/owner/repo`, an https or ssh remote, or any GitHub web URL inside a repository. */
export function parse(input: string, host = "github.com"): Ref | undefined {
  const ref = parseLoose(input, host)
  // Owner and name become API paths and permission resources; a `#`, `?` or `%` would make the two disagree.
  if (!ref || !NAME.test(ref.owner) || !NAME.test(ref.name) || ref.name === "." || ref.name === "..") return undefined
  return ref
}

const NAME = /^[A-Za-z0-9_.-]+$/

function parseLoose(input: string, host: string): Ref | undefined {
  const text = input.trim().replace(/\.git$/, "")
  const scp = /^(?:[\w.-]+@)?([\w.-]+):([\w.-]+)\/([\w.-]+?)\/?$/.exec(text)
  if (scp && !text.includes("://")) return { host: scp[1], owner: scp[2], name: scp[3] }
  if (text.includes("://")) {
    if (!URL.canParse(text)) return undefined
    const url = new URL(text)
    const [owner, name] = url.pathname.split("/").filter(Boolean)
    if (!owner || !name) return undefined
    return { host: url.hostname.replace(/^www\./, ""), owner, name: name.replace(/\.git$/, "") }
  }
  const parts = text.split("/").filter(Boolean)
  if (parts.length === 2) return { host, owner: parts[0], name: parts[1] }
  if (parts.length === 3 && parts[0].includes(".")) return { host: parts[0], owner: parts[1], name: parts[2] }
  return undefined
}

/** Parses a pull request, issue or discussion reference: `12`, `#12`, `owner/repo#12`, or a web URL. */
export function parseNumber(
  input: string | number,
  host = "github.com",
): { readonly repo?: Ref; readonly number: number } | undefined {
  if (typeof input === "number") return Number.isInteger(input) && input > 0 ? { number: input } : undefined
  const text = input.trim()
  const plain = /^#?(\d+)$/.exec(text)
  if (plain) return { number: Number(plain[1]) }
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text)
  if (short) {
    const repo = parse(short[1], host)
    return repo ? { repo, number: Number(short[2]) } : undefined
  }
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  const match = /^\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues|discussions)\/(\d+)/.exec(url.pathname)
  if (!match) return undefined
  return { repo: { host: url.hostname, owner: match[1], name: match[2] }, number: Number(match[3]) }
}

/**
 * Reads the repository from a working directory. Prefers the remote `gh repo set-default` selected, then the
 * current branch's push remote, then `origin`, then the first GitHub remote.
 */
export const local = Effect.fn("GitHubRepo.local")(function* (run: GitHubProcess.Run, directory: string) {
  const git = (args: string[]) =>
    run("git", ["-C", directory, ...args], { timeout: 10_000 }).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : "")),
    )
  const [remotes, branch, head, resolved] = yield* Effect.all(
    [
      git(["remote", "-v"]),
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(["rev-parse", "HEAD"]),
      git(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"]),
    ],
    { concurrency: "unbounded" },
  )
  // `git remote -v` lists a fetch and a push URL per remote. The repository is where a remote fetches from; a separate
  // pushurl (such as a fork) only says where the branch, and so the pull request head, lives.
  const listed = remotes
    .split("\n")
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 3)
  const urls = new Map(listed.filter((parts) => parts[2] === "(fetch)").map((parts) => [parts[0], parts[1]] as const))
  const pushUrls = new Map(
    listed.filter((parts) => parts[2] === "(push)").map((parts) => [parts[0], parts[1]] as const),
  )
  if (urls.size === 0)
    return yield* new GitHubClient.Error({
      kind: "not_found",
      message: `${directory} is not a git repository with remotes`,
      hint: "Pass `repo` as owner/name, or run from a clone of the repository.",
    })
  // `@{push}` applies push.default, remote.pushDefault and branch.<name>.pushRemote; the fetch tracking branch
  // (branch.<name>.merge) can name another repository's branch entirely.
  const pushRef = branch ? yield* git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]) : ""
  const pushRemote = [...urls.keys()]
    .filter((name) => pushRef.startsWith(`${name}/`))
    .toSorted((left, right) => right.length - left.length)[0]
  const configuredRemote = branch
    ? (yield* git(["config", "--get", `branch.${branch}.pushRemote`])) ||
      (yield* git(["config", "--get", "remote.pushDefault"])) ||
      (yield* git(["config", "--get", `branch.${branch}.remote`]))
    : ""
  const selected = resolved
    .split("\n")
    .map((line) => /^remote\.(.+)\.gh-resolved\s+base$/.exec(line.trim())?.[1])
    .find((name) => name !== undefined && urls.has(name))
  const order = [selected, pushRemote, configuredRemote, "origin", ...urls.keys()].filter(
    (name): name is string => !!name && urls.has(name),
  )
  const found = order.flatMap((name) => {
    const repo = parse(urls.get(name) ?? "")
    return repo ? [{ ...repo, host: normalizeHost(repo.host), remote: name }] : []
  })[0]
  if (!found)
    return yield* new GitHubClient.Error({
      kind: "not_found",
      message: `No GitHub remote found in ${directory}`,
      hint: "Pass `repo` as owner/name.",
    })
  const pushName = pushRemote ?? (configuredRemote && urls.has(configuredRemote) ? configuredRemote : found.remote)
  const pushRepo = parse(pushUrls.get(pushName) ?? urls.get(pushName) ?? "")
  const pushBranch = pushRemote ? pushRef.slice(pushRemote.length + 1) : branch
  return {
    ...found,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    ...(pushRepo && pushBranch
      ? { push: { ...pushRepo, host: normalizeHost(pushRepo.host), remote: pushName, branch: pushBranch } }
      : {}),
  } satisfies Local
})

// SSH host aliases such as `ssh.github.com` or `github.com-work` still mean github.com.
function normalizeHost(host: string) {
  if (host === "ssh.github.com" || /^github\.com[-_.]/.test(host) || host.endsWith(".github.com")) return "github.com"
  return host
}
