import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { GitHubClient } from "../src/client.js"
import { GitHubProcess } from "../src/process.js"
import { GitHubRepo } from "../src/repo.js"
import { GitHubShared } from "../src/shared.js"
import { initRepo, it, tmpdirScoped, withEnv } from "./lib"
import { fakeGitHub, makeDeps } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined, GH_HOST: undefined }

/** Serves one streamed body in fixed chunks, optionally without a content-length, to exercise bounded downloads. */
const streaming = (body: string, chunk: number, declare: boolean) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const bytes = new TextEncoder().encode(body)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += chunk)
            controller.enqueue(bytes.subarray(offset, offset + chunk))
          controller.close()
        },
      })
      return HttpClientResponse.fromWeb(
        request,
        new Response(stream, { headers: declare ? { "content-length": String(bytes.length) } : {} }),
      )
    }),
  )

describe("GitHubClient.download", () => {
  it.live("a tail download keeps only the last bytes of a long body", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const api = GitHubClient.make({
          http: streaming("0123456789".repeat(10), 7, false),
          run: GitHubProcess.run,
        }).forHost("github.com")
        const result = yield* api.download("/logs", { maxBytes: 25, keep: "tail" })
        expect(result.truncated).toBe(true)
        expect(new TextDecoder().decode(result.bytes)).toBe("5678901234567890123456789")
      }),
    ),
  )

  it.live("a full download refuses a declared size over the limit before reading it", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const api = GitHubClient.make({
          http: streaming("x".repeat(100), 10, true),
          run: GitHubProcess.run,
        }).forHost("github.com")
        const failure = yield* api.download("/asset", { maxBytes: 50 }).pipe(Effect.flip)
        expect(failure.message).toBe("Download is 100 bytes, over the 50-byte limit.")
      }),
    ),
  )

  it.live("a full download without a declared size stops once the stream passes the limit", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const api = GitHubClient.make({
          http: streaming("x".repeat(100), 10, false),
          run: GitHubProcess.run,
        }).forHost("github.com")
        const failure = yield* api.download("/asset", { maxBytes: 50 }).pipe(Effect.flip)
        expect(failure.message).toBe("Download is 60 bytes, over the 50-byte limit.")
        const small = yield* api.download("/asset", { maxBytes: 100 })
        expect(small).toMatchObject({ truncated: false })
        expect(small.bytes.byteLength).toBe(100)
      }),
    ),
  )
})

describe("GitHubClient requests", () => {
  it.live("a body that breaks off after the headers is a network failure, not an empty answer", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        let calls = 0
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            calls++
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('[{"id":'))
                controller.error(new globalThis.Error("connection reset"))
              },
            })
            return HttpClientResponse.fromWeb(request, new Response(stream, { status: 200 }))
          }),
        )
        const api = GitHubClient.make({ http, run: GitHubProcess.run }).forHost("github.com")
        const failure = yield* api.json("GET", "/repos/acme/widgets/issues").pipe(Effect.flip)
        expect(failure.kind).toBe("network")
        expect(failure.message).toContain("Lost the connection to github.com while reading /repos/acme/widgets/issues")
        // GETs are retried twice before giving up.
        expect(calls).toBe(3)
      }),
    ),
  )
})

describe("GitHub writes", () => {
  it.live("any document with a mutation, even after a comment or fragment, is never sent twice", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        expect(GitHubClient.isMutation("# create it\nmutation { addStar(input: {}) { clientMutationId } }")).toBe(true)
        expect(
          GitHubClient.isMutation(
            "fragment F on Issue { id }\nmutation M { closeIssue(input: {}) { issue { ...F } } }",
          ),
        ).toBe(true)
        expect(GitHubClient.isMutation("query { viewer { login } }")).toBe(false)
        expect(GitHubClient.isMutation("{ node(id: $id) { ... on X { clientMutationId } } }")).toBe(false)
        const github = fakeGitHub({ "GRAPHQL addStar": { status: 502, body: { message: "Bad Gateway" } } })
        const api = GitHubClient.make({ http: github.http, run: GitHubProcess.run }).forHost("github.com")
        yield* api.graphql("# create it\nmutation { addStar(input: {}) { clientMutationId } }").pipe(Effect.flip)
        expect(github.requests).toHaveLength(1)
      }),
    ),
  )

  it.live("permission resources are lower-cased, since GitHub names are case-insensitive", () =>
    withEnv(env, () =>
      Effect.sync(() => {
        expect(GitHubShared.resource({ host: "github.com", owner: "ACME", name: "Secret" })).toBe(
          "github.com/acme/secret",
        )
      }),
    ),
  )
})

describe("GitHubRepo.local", () => {
  it.live("a fork branch that tracks the upstream default branch is still found where it is pushed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await initRepo(dir.path)
        const git = (...args: string[]) => $`git -C ${dir.path} ${args}`.quiet()
        await git("remote", "add", "origin", "git@github.com:alice/widgets.git")
        await git("remote", "add", "upstream", "https://github.com/acme/widgets.git")
        // `gh repo set-default` picked the upstream; the branch pulls from upstream/main and pushes to the fork.
        await git("config", "remote.upstream.gh-resolved", "base")
        await git("checkout", "-q", "-b", "feature")
        await git("config", "branch.feature.remote", "upstream")
        await git("config", "branch.feature.merge", "refs/heads/main")
        await git("config", "remote.pushDefault", "origin")
      })
      const local = yield* GitHubRepo.local(GitHubProcess.run, dir.path)
      expect(local).toMatchObject({
        host: "github.com",
        owner: "acme",
        name: "widgets",
        remote: "upstream",
        branch: "feature",
      })
      expect(local.push).toEqual({
        host: "github.com",
        owner: "alice",
        name: "widgets",
        remote: "origin",
        branch: "feature",
      })
    }),
  )
})

describe("GitHubRepo.parse", () => {
  it.live("refuses owner or name characters that would make the API path and the permission resource disagree", () =>
    Effect.sync(() => {
      expect(GitHubRepo.parse("acme/secret#suffix")).toBeUndefined()
      expect(GitHubRepo.parse("acme/secret?ignored=")).toBeUndefined()
      expect(GitHubRepo.parse("https://github.com/acme/se%23cret")).toBeUndefined()
      expect(GitHubRepo.parse("acme/..")).toBeUndefined()
      // The host chooses the credential; anything but a host name (and port) could send it elsewhere.
      expect(GitHubRepo.parse("example.org#.ghe.com/acme/widgets")).toBeUndefined()
      expect(GitHubRepo.parse("user@ghe.example.com/acme/widgets")).toBeUndefined()
      expect(GitHubRepo.parse("ghe.example.com:8443/acme/widgets")).toEqual({
        host: "ghe.example.com:8443",
        owner: "acme",
        name: "widgets",
      })
      expect(GitHubRepo.parse("acme/my-repo.js")).toEqual({ host: "github.com", owner: "acme", name: "my-repo.js" })
    }),
  )
})

describe("GitHubRepo.local with a push URL", () => {
  it.live("one remote that fetches from the repository and pushes to a fork keeps them apart", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await initRepo(dir.path)
        const git = (...args: string[]) => $`git -C ${dir.path} ${args}`.quiet()
        await git("remote", "add", "origin", "https://github.com/acme/widgets.git")
        await git("remote", "set-url", "--push", "origin", "git@github.com:alice/widgets.git")
        await git("config", "remote.origin.gh-resolved", "base")
        await git("checkout", "-q", "-b", "feature")
      })
      const local = yield* GitHubRepo.local(GitHubProcess.run, dir.path)
      expect(local).toMatchObject({ owner: "acme", name: "widgets", remote: "origin", branch: "feature" })
      expect(local.push).toEqual({
        host: "github.com",
        owner: "alice",
        name: "widgets",
        remote: "origin",
        branch: "feature",
      })
    }),
  )
})

describe("GitHubShared.numbered", () => {
  it.live("a shorthand owner/repo#n reference keeps the effective Enterprise host", () =>
    withEnv({ ...env, GH_HOST: "ghe.example.com", GH_ENTERPRISE_TOKEN: "ghe-token" }, () =>
      Effect.gen(function* () {
        const { deps } = yield* makeDeps({ http: fakeGitHub({}).http })
        const shorthand = yield* GitHubShared.numbered(deps, { ref: "acme/widgets#3" })
        expect(shorthand.repo).toEqual({ host: "ghe.example.com", owner: "acme", name: "widgets" })
        expect(shorthand.api.host).toBe("ghe.example.com")
        const url = yield* GitHubShared.numbered(deps, { ref: "https://github.com/acme/widgets/issues/4" })
        expect(url.repo.host).toBe("github.com")
      }),
    ),
  )
})

describe("GitHubShared.numbered in an Enterprise checkout", () => {
  it.live("an unqualified repository and a shorthand reference stay on the checkout's host", () =>
    withEnv({ ...env, GH_ENTERPRISE_TOKEN: "ghe-token" }, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* Effect.promise(async () => {
          await initRepo(dir.path)
          await $`git -C ${dir.path} remote add origin git@ghe.example.com:acme/widgets.git`.quiet()
        })
        const { deps } = yield* makeDeps({ http: fakeGitHub({}).http, directory: dir.path })
        const shorthand = yield* GitHubShared.numbered(deps, { repo: "acme/widgets", ref: "acme/other#3" })
        expect(shorthand.repo).toEqual({ host: "ghe.example.com", owner: "acme", name: "other" })
        const plain = yield* GitHubShared.numbered(deps, { repo: "acme/widgets", ref: 3 })
        expect(plain.repo).toEqual({ host: "ghe.example.com", owner: "acme", name: "widgets" })
      }),
    ),
  )
})

describe("GitHubShared.refPath", () => {
  it.live("encodes each ref segment but keeps the slashes between them", () =>
    Effect.sync(() => {
      expect(GitHubShared.refPath("v1#rc1")).toBe("v1%23rc1")
      expect(GitHubShared.refPath("release/2026?q")).toBe("release/2026%3Fq")
    }),
  )
})
