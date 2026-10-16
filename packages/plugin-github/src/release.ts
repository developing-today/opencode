export * as GitHubReleases from "./release.js"

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api

interface AssetData {
  readonly id: number
  readonly name: string
  readonly label?: string | null
  readonly size: number
  readonly download_count: number
  readonly content_type: string
  readonly browser_download_url: string
}

interface ReleaseData {
  readonly id: number
  readonly tag_name: string
  readonly name: string | null
  readonly body?: string | null
  readonly draft: boolean
  readonly prerelease: boolean
  readonly target_commitish?: string
  readonly published_at: string | null
  readonly created_at?: string
  readonly html_url: string
  readonly upload_url?: string
  readonly author?: { readonly login: string } | null
  readonly assets: ReadonlyArray<AssetData>
}

const ASSET_BYTES = 512 * 1024 * 1024

// Common release asset types; anything else uploads as application/octet-stream.
const MIME: Record<string, string> = {
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".tar": "application/x-tar",
  ".xz": "application/x-xz",
  ".bz2": "application/x-bzip2",
  ".7z": "application/x-7z-compressed",
  ".zst": "application/zstd",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".sha256": "text/plain",
  ".asc": "application/pgp-signature",
  ".sig": "application/pgp-signature",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".html": "text/html",
  ".dmg": "application/x-apple-diskimage",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
  ".msi": "application/x-msi",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".apk": "application/vnd.android.package-archive",
  ".jar": "application/java-archive",
  ".wasm": "application/wasm",
}

const io = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new GitHubClient.Error({
        kind: "validation",
        message: `${label}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`,
      }),
  })

/**
 * Finds a release by exact tag, including drafts, which the tags endpoint does not return. Only reads may ask for
 * "latest": for a change, a tag named latest must not silently become whichever release GitHub marks latest.
 */
const byTag = Effect.fn("GitHubReleases.byTag")(function* (
  api: Api,
  slug: string,
  tag: string,
  options: { readonly latest?: boolean } = {},
) {
  if (tag === "latest" && options.latest) return yield* api.json<ReleaseData>("GET", `/repos/${slug}/releases/latest`)
  const direct = yield* api.request<ReleaseData>("GET", `/repos/${slug}/releases/tags/${GitHubShared.refPath(tag)}`, {
    allow: [404],
  })
  if (direct.status !== 404) return direct.data
  const all = yield* api.paginate<ReleaseData>(`/repos/${slug}/releases`, { limit: 300 })
  const match = all.find((release) => release.tag_name === tag)
  if (match) return match
  return yield* new GitHubClient.Error({
    kind: "not_found",
    message: `No release with tag ${tag} in ${slug}.`,
    hint: "List them with releases.",
  })
})

/**
 * Approves and checks every local asset before anything is created, without reading their contents: uploads then read
 * one file at a time, so a release with many large binaries never holds them all in memory.
 */
const checkAssets = (deps: Deps, context: Tool.Context, paths: ReadonlyArray<string>) =>
  Effect.forEach(paths, (file) =>
    GitHubShared.readable(deps, context, file).pipe(
      Effect.flatMap((resolved) =>
        io(`Unable to read ${file}`, () => stat(resolved)).pipe(
          Effect.flatMap((info) =>
            info.isFile()
              ? Effect.succeed({
                  name: path.basename(resolved),
                  path: resolved,
                  contentType: MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream",
                })
              : Effect.fail(new GitHubClient.Error({ kind: "validation", message: `${file} is not a file.` })),
          ),
        ),
      ),
    ),
  )

const uploadAsset = (
  api: Api,
  slug: string,
  release: ReleaseData,
  asset: { readonly name: string; readonly path: string; readonly contentType: string },
  label?: string,
) => {
  // GitHub Enterprise Server has no uploads host; its release carries the upload URL template instead.
  const base = api.uploads
    ? `${api.uploads}/repos/${slug}/releases/${release.id}/assets`
    : (release.upload_url ?? "").replace(/\{.*\}$/, "")
  const query = new URLSearchParams({ name: asset.name, ...(label ? { label } : {}) })
  return io(`Unable to read ${asset.path}`, () => readFile(asset.path)).pipe(
    Effect.flatMap((bytes) => api.upload({ url: `${base}?${query}`, bytes, contentType: asset.contentType })),
    Effect.map((data) => data as AssetData),
  )
}

const Summary = Schema.Struct({
  id: Schema.Int,
  tag: Schema.String,
  name: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  url: Schema.String,
  assets: Schema.Int,
})

const Asset = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  bytes: Schema.Int,
  download_count: Schema.Int,
  content_type: Schema.String,
  url: Schema.String,
})

const Detail = Schema.Struct({
  id: Schema.Int,
  tag: Schema.String,
  name: Schema.NullOr(Schema.String),
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  published_at: Schema.NullOr(Schema.String),
  url: Schema.String,
  target: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  body: Schema.String,
  assets: Schema.Array(Asset),
})

const MakeLatest = Schema.optionalKey(Schema.Literals(["true", "false", "legacy"])).annotate({
  description: "Mark as the latest release. legacy: decide by creation date and semantic version.",
})

const TagField = Schema.String.annotate({ description: "Release tag, such as v1.2.0." })

export function tools(deps: Deps): Tool.Info[] {
  const releases = GitHubShared.define(deps, {
    name: "releases",
    description: 'List GitHub releases, or show one release (tag, or "latest") with its notes and assets.',
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      tag: Schema.optionalKey(Schema.String).annotate({ description: "Exact tag, or latest. Omit to list releases." }),
      limit: GitHubShared.limit(100, 10),
    }),
    output: Schema.Struct({ releases: Schema.optionalKey(Schema.Array(Summary)), release: Schema.optionalKey(Detail) }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        if (input.tag === undefined) {
          const all = yield* resolved.api.paginate<ReleaseData>(`/repos/${slug}/releases`, { limit: input.limit ?? 10 })
          return {
            releases: all.map((release) => ({
              id: release.id,
              tag: release.tag_name,
              name: release.name,
              draft: release.draft,
              prerelease: release.prerelease,
              published_at: release.published_at,
              url: release.html_url,
              assets: release.assets.length,
            })),
          }
        }
        const release = yield* byTag(resolved.api, slug, input.tag, { latest: true })
        return {
          release: {
            id: release.id,
            tag: release.tag_name,
            name: release.name,
            draft: release.draft,
            prerelease: release.prerelease,
            published_at: release.published_at,
            url: release.html_url,
            ...(release.target_commitish ? { target: release.target_commitish } : {}),
            ...(release.author ? { author: release.author.login } : {}),
            body: GitHubShared.clip(release.body, 6000),
            assets: release.assets.map((asset) => ({
              id: asset.id,
              name: asset.name,
              bytes: asset.size,
              download_count: asset.download_count,
              content_type: asset.content_type,
              url: asset.browser_download_url,
            })),
          },
        }
      }),
  })

  const releaseCreate = GitHubShared.define(deps, {
    name: "release_create",
    description:
      "Create a GitHub release for a tag (created from target if missing), optionally as a draft or with generated notes, and upload local files as assets.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      tag: TagField,
      name: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String).annotate({ description: "Release notes in Markdown." }),
      target: Schema.optionalKey(Schema.String).annotate({
        description: "Branch or commit SHA for a new tag. Defaults to the default branch.",
      }),
      draft: Schema.optionalKey(Schema.Boolean),
      prerelease: Schema.optionalKey(Schema.Boolean),
      generate_notes: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Let GitHub generate notes; body is prepended.",
      }),
      make_latest: MakeLatest,
      discussion_category: Schema.optionalKey(Schema.String).annotate({
        description: "Start a discussion in this category.",
      }),
      assets: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Local file paths to upload, relative to the working directory.",
      }),
    }),
    output: Schema.Struct({
      id: Schema.Int,
      tag: Schema.String,
      url: Schema.String,
      draft: Schema.Boolean,
      assets: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
      warnings: Schema.Array(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        // Check every file first so a bad path fails before the release exists.
        const files = yield* checkAssets(deps, context, input.assets ?? [])
        yield* GitHubShared.authorize(deps, context, "release_create", resolved.repo, { tag: input.tag })
        const release = yield* resolved.api.json<ReleaseData>("POST", `/repos/${slug}/releases`, {
          body: {
            tag_name: input.tag,
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.target !== undefined ? { target_commitish: input.target } : {}),
            ...(input.draft !== undefined ? { draft: input.draft } : {}),
            ...(input.prerelease !== undefined ? { prerelease: input.prerelease } : {}),
            ...(input.generate_notes !== undefined ? { generate_release_notes: input.generate_notes } : {}),
            ...(input.make_latest !== undefined ? { make_latest: input.make_latest } : {}),
            ...(input.discussion_category !== undefined ? { discussion_category_name: input.discussion_category } : {}),
          },
        })
        const uploads = yield* Effect.forEach(files, (file) =>
          uploadAsset(resolved.api, slug, release, file).pipe(
            Effect.map((asset) => ({ name: asset.name, url: asset.browser_download_url })),
            Effect.catch((error: GitHubClient.Error) =>
              Effect.succeed(`Upload of ${file.name} failed: ${error.message}`),
            ),
          ),
        )
        return {
          id: release.id,
          tag: release.tag_name,
          url: release.html_url,
          draft: release.draft,
          assets: uploads.filter((item) => typeof item !== "string"),
          warnings: [
            ...uploads.filter((item) => typeof item === "string"),
            ...(uploads.some((item) => typeof item === "string")
              ? [
                  `The release exists; retry failed uploads with release_asset({ action: "upload", tag: "${release.tag_name}", paths: [...] }).`,
                ]
              : []),
          ],
        }
      }),
  })

  const releaseUpdate = GitHubShared.define(deps, {
    name: "release_update",
    description:
      "Edit a GitHub release (name, notes, draft, prerelease, latest), delete some of its assets, or delete the release and optionally its tag.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      tag: Schema.optionalKey(TagField),
      id: Schema.optionalKey(Schema.Int).annotate({ description: "Release id, instead of tag." }),
      name: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
      draft: Schema.optionalKey(Schema.Boolean).annotate({ description: "false publishes a draft." }),
      prerelease: Schema.optionalKey(Schema.Boolean),
      make_latest: MakeLatest,
      delete: Schema.optionalKey(Schema.Boolean).annotate({ description: "Delete the release." }),
      delete_tag: Schema.optionalKey(Schema.Boolean).annotate({ description: "With delete: also delete the git tag." }),
      delete_assets: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "Asset names to delete.",
      }),
    }),
    output: Schema.Struct({
      id: Schema.optionalKey(Schema.Int),
      tag: Schema.String,
      url: Schema.optionalKey(Schema.String),
      changed: Schema.Array(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.tag === undefined && input.id === undefined)
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass tag or id." })
        if (input.delete_tag && !input.delete)
          return yield* new GitHubClient.Error({ kind: "validation", message: "delete_tag requires delete: true." })
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        const api = resolved.api
        const release =
          input.id !== undefined
            ? yield* api.json<ReleaseData>("GET", `/repos/${slug}/releases/${input.id}`)
            : yield* byTag(api, slug, input.tag ?? "")
        yield* GitHubShared.authorize(deps, context, "release_update", resolved.repo, {
          tag: release.tag_name,
          delete: input.delete === true,
        })
        if (input.delete) {
          yield* api.request("DELETE", `/repos/${slug}/releases/${release.id}`)
          if (input.delete_tag)
            yield* api.request("DELETE", `/repos/${slug}/git/refs/tags/${GitHubShared.refPath(release.tag_name)}`)
          return {
            tag: release.tag_name,
            changed: ["deleted release", ...(input.delete_tag ? [`deleted tag ${release.tag_name}`] : [])],
          }
        }
        const missing = (input.delete_assets ?? []).filter(
          (name) => !release.assets.some((asset) => asset.name === name),
        )
        if (missing.length > 0)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            message: `No asset named ${missing.join(", ")} on ${release.tag_name}.`,
            hint: `Assets: ${release.assets.map((asset) => asset.name).join(", ") || "none"}.`,
          })
        const removed = release.assets.filter((asset) => input.delete_assets?.includes(asset.name))
        yield* Effect.forEach(removed, (asset) => api.request("DELETE", `/repos/${slug}/releases/assets/${asset.id}`), {
          discard: true,
        })
        const patch = Object.fromEntries(
          (["name", "body", "draft", "prerelease", "make_latest"] as const).flatMap((key) =>
            input[key] === undefined ? [] : [[key, input[key]] as const],
          ),
        )
        const updated =
          Object.keys(patch).length > 0
            ? yield* api.json<ReleaseData>("PATCH", `/repos/${slug}/releases/${release.id}`, { body: patch })
            : release
        return {
          id: updated.id,
          tag: updated.tag_name,
          url: updated.html_url,
          changed: [...Object.keys(patch), ...removed.map((asset) => `deleted asset ${asset.name}`)],
        }
      }),
  })

  const releaseNotes = GitHubShared.define(deps, {
    name: "release_notes",
    description: "Preview the release notes GitHub would generate for a tag, without creating a release.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      tag: TagField,
      target: Schema.optionalKey(Schema.String).annotate({
        description: "Branch or commit for a tag that does not exist yet.",
      }),
      previous_tag: Schema.optionalKey(Schema.String).annotate({
        description: "Start of the range. Defaults to the previous release.",
      }),
    }),
    output: Schema.Struct({ name: Schema.String, body: Schema.String }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const notes = yield* resolved.api.json<{ name: string; body: string }>(
          "POST",
          `/repos/${GitHubRepo.slug(resolved.repo)}/releases/generate-notes`,
          {
            body: {
              tag_name: input.tag,
              ...(input.target ? { target_commitish: input.target } : {}),
              ...(input.previous_tag ? { previous_tag_name: input.previous_tag } : {}),
            },
          },
        )
        return { name: notes.name, body: GitHubShared.clip(notes.body, 20000) }
      }),
  })

  const releaseAsset = GitHubShared.define(deps, {
    name: "release_asset",
    description:
      "Upload local files to a GitHub release, or download release assets (by name, id, or all) to a local directory.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      action: Schema.Literals(["upload", "download"]),
      tag: TagField,
      paths: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
        description: "upload: local files, relative to the working directory.",
      }),
      label: Schema.optionalKey(Schema.String).annotate({ description: "upload: display label for the asset." }),
      overwrite: Schema.optionalKey(Schema.Boolean).annotate({
        description: "upload: replace assets with the same name.",
      }),
      name: Schema.optionalKey(Schema.String).annotate({
        description: "download: asset name. Omit name and id to download all.",
      }),
      id: Schema.optionalKey(Schema.Int).annotate({ description: "download: asset id." }),
      path: Schema.optionalKey(Schema.String).annotate({
        description:
          "download: destination directory, relative to the working directory. Defaults to a temporary directory.",
      }),
    }),
    output: Schema.Struct({
      action: Schema.String,
      files: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          path: Schema.optionalKey(Schema.String),
          url: Schema.optionalKey(Schema.String),
          bytes: Schema.Int,
        }),
      ),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        const api = resolved.api
        const release = yield* byTag(api, slug, input.tag, { latest: input.action === "download" })
        if (input.action === "upload") {
          if (!input.paths?.length)
            return yield* new GitHubClient.Error({ kind: "validation", message: "upload needs paths." })
          const files = yield* checkAssets(deps, context, input.paths)
          const clashes = release.assets.filter((asset) => files.some((file) => file.name === asset.name))
          if (clashes.length > 0 && !input.overwrite)
            return yield* new GitHubClient.Error({
              kind: "conflict",
              message: `${release.tag_name} already has ${clashes.map((asset) => asset.name).join(", ")}.`,
              hint: "Pass overwrite: true to replace them.",
            })
          yield* GitHubShared.authorize(deps, context, "release_asset", resolved.repo, { tag: release.tag_name })
          yield* Effect.forEach(
            clashes,
            (asset) => api.request("DELETE", `/repos/${slug}/releases/assets/${asset.id}`),
            { discard: true },
          )
          const uploaded = yield* Effect.forEach(files, (file) => uploadAsset(api, slug, release, file, input.label))
          return {
            action: "upload",
            files: uploaded.map((asset) => ({ name: asset.name, url: asset.browser_download_url, bytes: asset.size })),
          }
        }
        const chosen = release.assets.filter(
          (asset) =>
            (input.name === undefined || asset.name === input.name) &&
            (input.id === undefined || asset.id === input.id),
        )
        if (chosen.length === 0)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            message: `No matching asset on ${release.tag_name}.`,
            hint: `Assets: ${release.assets.map((asset) => asset.name).join(", ") || "none"}.`,
          })
        // The default scratch directory is per host, repository and tag so downloads from different repositories never
        // overwrite each other; a caller-chosen directory needs write approval.
        const directory = input.path
          ? yield* GitHubShared.writable(deps, context, input.path)
          : path.join(
              os.tmpdir(),
              "opencode-github",
              "releases",
              // Encoded, not replaced, so distinct tags such as release/v1 and release_v1 stay distinct.
              ...[resolved.repo.host, resolved.repo.owner, resolved.repo.name, release.tag_name].map(
                encodeURIComponent,
              ),
            )
        yield* io("Unable to create directory", () => mkdir(directory, { recursive: true }))
        const files = yield* Effect.forEach(
          chosen,
          (asset) =>
            Effect.gen(function* () {
              const download = yield* api.download(`/repos/${slug}/releases/assets/${asset.id}`, {
                accept: "application/octet-stream",
                maxBytes: ASSET_BYTES,
              })
              if (download.truncated)
                return yield* new GitHubClient.Error({
                  kind: "unsupported",
                  message: `${asset.name} is larger than 512 MB.`,
                })
              // Asset names cannot contain path separators on GitHub, but guard against writing outside the directory.
              const file = path.join(directory, path.basename(asset.name))
              // Approve the file itself: a rule can deny one path inside a directory that is otherwise writable.
              if (input.path) yield* GitHubShared.writableFile(deps, context, file)
              yield* io(`Unable to write ${file}`, () => writeFile(file, download.bytes))
              return { name: asset.name, path: file, bytes: download.bytes.byteLength }
            }),
          // One at a time, so at most one asset is held in memory.
          { concurrency: 1 },
        )
        return { action: "download", files }
      }),
  })

  return [releases, releaseCreate, releaseUpdate, releaseNotes, releaseAsset]
}
