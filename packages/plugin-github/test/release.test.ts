import { describe, expect } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { GitHubReleases } from "../src/release.js"
import { it, tmpdirScoped, withEnv } from "./lib"
import { fakeGitHub, find, makeDeps, run } from "./fixture"

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }

/**
 * Wraps the JSON fake: answers `METHOD /path` keys in `raw` with bytes (asset downloads), and records each request's
 * body content type, which the fake does not keep.
 */
function wrap(github: ReturnType<typeof fakeGitHub>, raw: Record<string, string> = {}) {
  const sent: Array<{ method: string; url: string; contentType?: string; accept?: string }> = []
  const http = HttpClient.make((request) => {
    const url = new URL(request.url)
    sent.push({
      method: request.method,
      url: request.url,
      ...(request.body._tag === "Uint8Array" ? { contentType: request.body.contentType } : {}),
      ...(request.headers.accept ? { accept: request.headers.accept } : {}),
    })
    const text = raw[`${request.method} ${url.pathname}`]
    if (text === undefined) return github.http.execute(request)
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: 200, headers: { "content-type": "application/octet-stream" } }),
      ),
    )
  })
  return { http, sent }
}

const asset = {
  id: 7,
  name: "app.zip",
  size: 14,
  download_count: 3,
  content_type: "application/zip",
  browser_download_url: "https://github.com/acme/widgets/releases/download/v1.0.0/app.zip",
}

const release = {
  id: 42,
  tag_name: "v1.0.0",
  name: "Version 1",
  body: "## Changes\n- Faster parser",
  draft: false,
  prerelease: false,
  target_commitish: "main",
  published_at: "2026-01-02T00:00:00Z",
  html_url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
  upload_url: "https://uploads.github.com/repos/acme/widgets/releases/42/assets{?name,label}",
  author: { login: "octocat" },
  assets: [asset],
}

describe("github release tools", () => {
  it.live("releases lists summaries without a tag and shows one release with assets for a tag", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/releases": {
            body: [
              release,
              { ...release, id: 41, tag_name: "v0.9.0", name: null, draft: true, published_at: null, assets: [] },
            ],
          },
          "GET /repos/acme/widgets/releases/tags/v1.0.0": { body: release },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubReleases.tools(deps), "releases")
        expect(yield* run(tool, { repo: "acme/widgets" })).toEqual({
          releases: [
            {
              id: 42,
              tag: "v1.0.0",
              name: "Version 1",
              draft: false,
              prerelease: false,
              published_at: "2026-01-02T00:00:00Z",
              url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
              assets: 1,
            },
            {
              id: 41,
              tag: "v0.9.0",
              name: null,
              draft: true,
              prerelease: false,
              published_at: null,
              url: release.html_url,
              assets: 0,
            },
          ],
        })
        expect(yield* run(tool, { repo: "acme/widgets", tag: "v1.0.0" })).toEqual({
          release: {
            id: 42,
            tag: "v1.0.0",
            name: "Version 1",
            draft: false,
            prerelease: false,
            published_at: "2026-01-02T00:00:00Z",
            url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
            target: "main",
            author: "octocat",
            body: "## Changes\n- Faster parser",
            assets: [
              {
                id: 7,
                name: "app.zip",
                bytes: 14,
                download_count: 3,
                content_type: "application/zip",
                url: "https://github.com/acme/widgets/releases/download/v1.0.0/app.zip",
              },
            ],
          },
        })
      }),
    ),
  )

  it.live("releases finds a draft by tag when the tags endpoint does not", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/releases/tags/v2.0.0": { status: 404, body: { message: "Not Found" } },
          "GET /repos/acme/widgets/releases": {
            body: [{ ...release, id: 50, tag_name: "v2.0.0", draft: true, published_at: null }],
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run<object, { release: { id: number; draft: boolean } }>(
          find(GitHubReleases.tools(deps), "releases"),
          {
            repo: "acme/widgets",
            tag: "v2.0.0",
          },
        )
        expect([output.release.id, output.release.draft]).toEqual([50, true])
      }),
    ),
  )

  it.live("release_create creates the release, then uploads local files to the uploads host", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        yield* Effect.promise(() =>
          mkdir(path.join(dir.path, "dist")).then(() =>
            writeFile(path.join(dir.path, "dist", "app.zip"), "zip-bytes-here"),
          ),
        )
        const github = fakeGitHub({
          "POST /repos/acme/widgets/releases": { status: 201, body: { ...release, assets: [] } },
          "POST /repos/acme/widgets/releases/42/assets": { status: 201, body: asset },
        })
        const http = wrap(github)
        const { deps, asserted } = yield* makeDeps({ http: http.http, directory: dir.path })
        const output = yield* run(find(GitHubReleases.tools(deps), "release_create"), {
          repo: "acme/widgets",
          tag: "v1.0.0",
          name: "Version 1",
          generate_notes: true,
          make_latest: "true",
          assets: ["dist/app.zip"],
        })
        expect(output).toEqual({
          id: 42,
          tag: "v1.0.0",
          url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
          draft: false,
          assets: [{ name: "app.zip", url: "https://github.com/acme/widgets/releases/download/v1.0.0/app.zip" }],
          warnings: [],
        })
        expect(github.requests.map((request) => [request.method, request.url, request.body])).toEqual([
          [
            "POST",
            "https://api.github.com/repos/acme/widgets/releases",
            { tag_name: "v1.0.0", name: "Version 1", generate_release_notes: true, make_latest: "true" },
          ],
          ["POST", "https://uploads.github.com/repos/acme/widgets/releases/42/assets?name=app.zip", "zip-bytes-here"],
        ])
        expect(http.sent[1]).toMatchObject({ contentType: "application/zip" })
        expect(asserted.map((item) => item.action)).toEqual(["github_release_create"])
      }),
    ),
  )

  it.live("release_create fails before creating anything when an asset path does not exist", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const github = fakeGitHub({})
        const { deps } = yield* makeDeps({ http: github.http, directory: dir.path })
        const error = yield* run(find(GitHubReleases.tools(deps), "release_create"), {
          repo: "acme/widgets",
          tag: "v1.0.0",
          assets: ["missing.zip"],
        }).pipe(Effect.flip)
        expect(String(error)).toContain("Unable to read missing.zip")
        expect(github.requests).toEqual([])
      }),
    ),
  )

  it.live("release_update deletes the release and its tag", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/releases/tags/v1.0.0": { body: release },
          "DELETE /repos/acme/widgets/releases/42": { status: 204 },
          "DELETE /repos/acme/widgets/git/refs/tags/v1.0.0": { status: 204 },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubReleases.tools(deps), "release_update"), {
          repo: "acme/widgets",
          tag: "v1.0.0",
          delete: true,
          delete_tag: true,
        })
        expect(output).toEqual({ tag: "v1.0.0", changed: ["deleted release", "deleted tag v1.0.0"] })
        expect(github.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
          "GET /repos/acme/widgets/releases/tags/v1.0.0",
          "DELETE /repos/acme/widgets/releases/42",
          "DELETE /repos/acme/widgets/git/refs/tags/v1.0.0",
        ])
        expect(asserted.map((item) => item.action)).toEqual(["github_release_update"])
      }),
    ),
  )

  it.live("a change to a release tagged latest targets that exact tag, never GitHub's latest release", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const tagged = { ...release, id: 50, tag_name: "latest", prerelease: true }
        const github = fakeGitHub({
          "GET /repos/acme/widgets/releases/tags/latest": { body: tagged },
          "GET /repos/acme/widgets/releases/latest": { body: release },
          "DELETE /repos/acme/widgets/releases/50": { status: 204 },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        yield* run(find(GitHubReleases.tools(deps), "release_update"), {
          repo: "acme/widgets",
          tag: "latest",
          delete: true,
        })
        expect(github.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
          "GET /repos/acme/widgets/releases/tags/latest",
          "DELETE /repos/acme/widgets/releases/50",
        ])
        // Reading still follows GitHub's latest release.
        const read = yield* run<object, { release: { tag: string } }>(find(GitHubReleases.tools(deps), "releases"), {
          repo: "acme/widgets",
          tag: "latest",
        })
        expect(read.release.tag).toBe("v1.0.0")
      }),
    ),
  )

  it.live("release_update patches fields and deletes named assets", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GET /repos/acme/widgets/releases/42": { body: release },
          "DELETE /repos/acme/widgets/releases/assets/7": { status: 204 },
          "PATCH /repos/acme/widgets/releases/42": { body: { ...release, draft: false, name: "Version 1.0" } },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubReleases.tools(deps), "release_update"), {
          repo: "acme/widgets",
          id: 42,
          name: "Version 1.0",
          draft: false,
          delete_assets: ["app.zip"],
        })
        expect(output).toEqual({
          id: 42,
          tag: "v1.0.0",
          url: "https://github.com/acme/widgets/releases/tag/v1.0.0",
          changed: ["name", "draft", "deleted asset app.zip"],
        })
        expect(github.requests.map((request) => [request.method, request.path, request.body])).toEqual([
          ["GET", "/repos/acme/widgets/releases/42", undefined],
          ["DELETE", "/repos/acme/widgets/releases/assets/7", undefined],
          ["PATCH", "/repos/acme/widgets/releases/42", { name: "Version 1.0", draft: false }],
        ])
      }),
    ),
  )

  it.live("release_asset download writes the asset bytes to the destination directory", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped()
        const github = fakeGitHub({ "GET /repos/acme/widgets/releases/tags/v1.0.0": { body: release } })
        const http = wrap(github, { "GET /repos/acme/widgets/releases/assets/7": "zip-bytes-here" })
        const { deps, asserted, approvals } = yield* makeDeps({ http: http.http, directory: dir.path })
        const output = yield* run(find(GitHubReleases.tools(deps), "release_asset"), {
          repo: "acme/widgets",
          action: "download",
          tag: "v1.0.0",
          name: "app.zip",
          path: "downloads",
        })
        const file = path.join(dir.path, "downloads", "app.zip")
        expect(output).toEqual({ action: "download", files: [{ name: "app.zip", path: file, bytes: 14 }] })
        expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("zip-bytes-here")
        expect(http.sent.at(-1)).toEqual({
          method: "GET",
          url: "https://api.github.com/repos/acme/widgets/releases/assets/7",
          accept: "application/octet-stream",
        })
        // A caller-chosen destination needs the write tool's approvals before anything is written there.
        const destination = path.join(dir.path, "downloads")
        expect(approvals).toEqual([{ kind: "external", path: destination }])
        // The file itself is approved too, so a rule denying one path inside the directory still holds.
        expect(asserted.map((item) => [item.action, item.resources])).toEqual([
          ["edit", [destination]],
          ["edit", [file]],
        ])
      }),
    ),
  )

  it.live("release_asset download defaults to a scratch directory per repository and tag", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({ "GET /repos/acme/widgets/releases/tags/v1.0.0": { body: release } })
        const http = wrap(github, { "GET /repos/acme/widgets/releases/assets/7": "zip-bytes-here" })
        const { deps, asserted } = yield* makeDeps({ http: http.http })
        const output = yield* run<object, { files: Array<{ path: string }> }>(
          find(GitHubReleases.tools(deps), "release_asset"),
          { repo: "acme/widgets", action: "download", tag: "v1.0.0", name: "app.zip" },
        )
        expect(output.files[0]?.path).toBe(
          path.join(os.tmpdir(), "opencode-github", "releases", "github.com", "acme", "widgets", "v1.0.0", "app.zip"),
        )
        expect(asserted).toEqual([])
        // Distinct tags keep distinct directories: a slash is encoded, not folded into an underscore.
        const slashed = fakeGitHub({
          "GET /repos/acme/widgets/releases/tags/release/v1": { body: { ...release, tag_name: "release/v1" } },
        })
        const other = wrap(slashed, { "GET /repos/acme/widgets/releases/assets/7": "zip-bytes-here" })
        const second = yield* makeDeps({ http: other.http })
        const nested = yield* run<object, { files: Array<{ path: string }> }>(
          find(GitHubReleases.tools(second.deps), "release_asset"),
          { repo: "acme/widgets", action: "download", tag: "release/v1", name: "app.zip" },
        )
        expect(nested.files[0]?.path).toBe(
          path.join(
            os.tmpdir(),
            "opencode-github",
            "releases",
            "github.com",
            "acme",
            "widgets",
            "release%2Fv1",
            "app.zip",
          ),
        )
      }),
    ),
  )

  it.live("release_notes previews generated notes", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "POST /repos/acme/widgets/releases/generate-notes": {
            body: { name: "v1.1.0", body: "## What's Changed\n* Fix" },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const output = yield* run(find(GitHubReleases.tools(deps), "release_notes"), {
          repo: "acme/widgets",
          tag: "v1.1.0",
          previous_tag: "v1.0.0",
        })
        expect(output).toEqual({ name: "v1.1.0", body: "## What's Changed\n* Fix" })
        expect(github.requests[0].body).toEqual({ tag_name: "v1.1.0", previous_tag_name: "v1.0.0" })
      }),
    ),
  )
})
