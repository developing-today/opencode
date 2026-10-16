import { describe, expect } from "bun:test"
import { $ } from "bun"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { GitHubClient } from "@opencode/core/tool/plugin/github/client"
import { GitHubRepo } from "@opencode/core/tool/plugin/github/repo"
import { GitHubShared } from "@opencode/core/tool/plugin/github/shared"
import { withEnv } from "../fixture/env"
import { initRepo } from "../fixture/git"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { fakeGitHub, makeDeps } from "./fixture"

const it = testEffect(LayerNode.compile(AppProcess.node))
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
          process: yield* AppProcess.Service,
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
          process: yield* AppProcess.Service,
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
          process: yield* AppProcess.Service,
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
        const api = GitHubClient.make({ http, process: yield* AppProcess.Service }).forHost("github.com")
        const failure = yield* api.json("GET", "/repos/acme/widgets/issues").pipe(Effect.flip)
        expect(failure.kind).toBe("network")
        expect(failure.message).toContain("Lost the connection to github.com while reading /repos/acme/widgets/issues")
        // GETs are retried twice before giving up.
        expect(calls).toBe(3)
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
      const local = yield* GitHubRepo.local(yield* AppProcess.Service, dir.path)
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

describe("GitHubShared.refPath", () => {
  it.live("encodes each ref segment but keeps the slashes between them", () =>
    Effect.sync(() => {
      expect(GitHubShared.refPath("v1#rc1")).toBe("v1%23rc1")
      expect(GitHubShared.refPath("release/2026?q")).toBe("release/2026%3Fq")
    }),
  )
})
