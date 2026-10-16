export * as GitHubActions from "./actions.js"

import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Tool } from "@opencode/schema/tool"
import { AppProcess } from "@opencode/util/process"
import { Clock, Effect, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { GitHubClient } from "./client.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps
type Api = GitHubClient.Api

// ---------------------------------------------------------------------------------------------------------------
// GitHub data
// ---------------------------------------------------------------------------------------------------------------

interface WorkflowData {
  readonly id: number
  readonly name: string
  readonly path: string
  readonly state: string
  readonly html_url: string
}

interface RunData {
  readonly id: number
  readonly name: string | null
  readonly display_title?: string
  readonly event: string
  readonly status: string | null
  readonly conclusion: string | null
  readonly head_branch: string | null
  readonly head_sha: string
  readonly run_attempt?: number
  readonly html_url: string
  readonly created_at: string
  readonly updated_at: string
  readonly run_started_at?: string
}

interface StepData {
  readonly number: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
}

interface JobData {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly conclusion: string | null
  readonly html_url: string | null
  readonly started_at?: string | null
  readonly completed_at?: string | null
  readonly steps?: ReadonlyArray<StepData>
}

interface AnnotationData {
  readonly path: string
  readonly start_line?: number | null
  readonly annotation_level: string | null
  readonly title?: string | null
  readonly message: string
}

interface ArtifactData {
  readonly id: number
  readonly name: string
  readonly size_in_bytes: number
  readonly expired: boolean
  readonly created_at: string | null
  readonly workflow_run?: { readonly id?: number } | null
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"])
const failed = (conclusion: string | null | undefined) =>
  conclusion !== null && conclusion !== undefined && FAILED.has(conclusion)

const WORKFLOW_FILE = /\.ya?ml$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/
const ARTIFACT_BYTES = 500 * 1024 * 1024
const LOG_BYTES = 50 * 1024 * 1024
const SAVED_LOG_BYTES = 200 * 1024 * 1024

const scratch = (...parts: string[]) => path.join(os.tmpdir(), "opencode-github", ...parts)

const io = <A>(label: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new globalThis.Error(`${label}: ${cause instanceof globalThis.Error ? cause.message : String(cause)}`),
  })

/** Reads a run or job id from a number or an Actions URL; a URL also names the repository. */
function parseRef(value: string | number, kind: "run" | "job") {
  if (typeof value === "number") return { id: value }
  const text = value.trim()
  if (/^\d+$/.test(text)) return { id: Number(text) }
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  const match = /^\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url.pathname)
  const id = kind === "job" ? match?.[4] : match?.[3]
  if (!match || !id) return undefined
  return { id: Number(id), repo: `${url.hostname}/${match[1]}/${match[2]}` }
}

const locate = Effect.fn("GitHubActions.locate")(function* (
  deps: Deps,
  repo: string | undefined,
  value: string | number,
  kind: "run" | "job",
) {
  const parsed = parseRef(value, kind)
  if (!parsed)
    return yield* new GitHubClient.Error({
      kind: "validation",
      message: `Unrecognized ${kind}: ${value}. Pass a numeric id or an Actions ${kind} URL.`,
    })
  const resolved = yield* GitHubShared.target(deps, parsed.repo ?? repo)
  return { ...resolved, id: parsed.id }
})

/** Resolves a workflow id, file name or display name to something the workflows API accepts. */
const workflowRef = Effect.fn("GitHubActions.workflowRef")(function* (
  api: Api,
  slug: string,
  workflow: string | number,
) {
  const text = String(workflow).trim()
  if (/^\d+$/.test(text)) return text
  if (WORKFLOW_FILE.test(text)) return path.posix.basename(text)
  const all = yield* api.paginate<WorkflowData>(`/repos/${slug}/actions/workflows`, { key: "workflows", limit: 500 })
  const match = all.find((item) => item.name.toLowerCase() === text.toLowerCase())
  if (match) return String(match.id)
  return yield* new GitHubClient.Error({
    kind: "not_found",
    message: `No workflow named ${text} in ${slug}.`,
    hint: `Available: ${all.map((item) => `${item.name} (${path.posix.basename(item.path)})`).join(", ") || "none"}.`,
  })
})

const jobsOf = (api: Api, slug: string, run: number, attempt?: number) =>
  api.paginate<JobData>(
    attempt ? `/repos/${slug}/actions/runs/${run}/attempts/${attempt}/jobs` : `/repos/${slug}/actions/runs/${run}/jobs`,
    { key: "jobs", limit: 1000, ...(attempt ? {} : { query: { filter: "latest" } }) },
  )

function artifact(item: ArtifactData) {
  return {
    id: item.id,
    name: item.name,
    bytes: item.size_in_bytes,
    expired: item.expired,
    ...(item.created_at ? { created_at: item.created_at } : {}),
    ...(item.workflow_run?.id ? { run_id: item.workflow_run.id } : {}),
  }
}

function summary(run: RunData) {
  const started = Date.parse(run.run_started_at ?? run.created_at)
  const ended = Date.parse(run.updated_at)
  return {
    id: run.id,
    workflow: run.name ?? "",
    title: run.display_title ?? "",
    event: run.event,
    status: run.status ?? "unknown",
    conclusion: run.conclusion,
    branch: run.head_branch,
    sha: run.head_sha.slice(0, 7),
    attempt: run.run_attempt ?? 1,
    url: run.html_url,
    created_at: run.created_at,
    updated_at: run.updated_at,
    ...(run.status === "completed" && Number.isFinite(started) && Number.isFinite(ended)
      ? { duration_seconds: Math.max(0, Math.round((ended - started) / 1000)) }
      : {}),
  }
}

/** Reads `workflow_dispatch` and its inputs from workflow YAML without a YAML parser. */
export function dispatchInfo(text: string) {
  const lines = text.split(/\r?\n/)
  const indentOf = (line: string) => line.search(/\S/)
  const meaningful = (line: string) => line.trim() !== "" && !line.trim().startsWith("#")
  const inline = lines.some(
    (line) =>
      /^["']?on["']?\s*:\s*(?:workflow_dispatch|\[[^\]]*\bworkflow_dispatch\b[^\]]*\])\s*(?:#.*)?$/.test(line.trim()) ||
      /^\s*-\s*workflow_dispatch\s*(?:#.*)?$/.test(line),
  )
  const start = lines.findIndex((line) => /^\s*workflow_dispatch\s*:/.test(line))
  if (start < 0) return { dispatch: inline, inputs: [] }
  const base = indentOf(lines[start])
  const end = lines.findIndex((line, index) => index > start && meaningful(line) && indentOf(line) <= base)
  const block = lines.slice(start + 1, end < 0 ? undefined : end).filter(meaningful)
  const header = block.findIndex((line) => /^\s*inputs\s*:/.test(line))
  if (header < 0) return { dispatch: true, inputs: [] }
  const headerIndent = indentOf(block[header])
  const after = block.slice(header + 1)
  const stop = after.findIndex((line) => indentOf(line) <= headerIndent)
  const body = after.slice(0, stop < 0 ? undefined : stop)
  const keyIndent = body[0] ? indentOf(body[0]) : 0
  const scalar = (value: string) =>
    value
      .replace(/\s+#.*$/, "")
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2")
  const inputs = body.reduce<Array<{ name: string; required?: boolean; type?: string; default?: string }>>(
    (all, line) => {
      const key = /^\s*([\w-]+)\s*:/.exec(line)
      if (indentOf(line) === keyIndent && key) return [...all, { name: key[1] }]
      const property = /^\s*(required|type|default)\s*:\s*(.*)$/.exec(line)
      const current = all.at(-1)
      if (!property || !current || indentOf(line) <= keyIndent) return all
      const value = scalar(property[2])
      if (property[1] === "required") return [...all.slice(0, -1), { ...current, required: value === "true" }]
      if (property[1] === "type") return [...all.slice(0, -1), { ...current, type: value }]
      return [...all.slice(0, -1), { ...current, default: value }]
    },
    [],
  )
  return { dispatch: true, inputs }
}

/** Selects the lines to show from a job log: an optional regex with context, then the last `tail` lines. */
export function excerpt(
  raw: string,
  options: { readonly tail: number; readonly grep?: RegExp; readonly context: number; readonly timestamps: boolean },
) {
  const lines = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => (options.timestamps ? line : line.replace(TIMESTAMP, "")))
  if (lines.at(-1) === "") lines.pop()
  const pattern = options.grep
  const selected = pattern
    ? lines
        .flatMap((line, index) => (pattern.test(line) ? [index] : []))
        .reduce<Array<[number, number]>>((ranges, index) => {
          const from = Math.max(0, index - options.context)
          const to = Math.min(lines.length - 1, index + options.context)
          const last = ranges.at(-1)
          if (last && from <= last[1] + 1) return [...ranges.slice(0, -1), [last[0], Math.max(last[1], to)]]
          return [...ranges, [from, to]]
        }, [])
        .flatMap((range, index) => [
          ...(index > 0 ? ["--"] : []),
          ...lines.slice(range[0], range[1] + 1).map((line, offset) => `${range[0] + offset + 1}: ${line}`),
        ])
    : lines
  const shown = selected.slice(-options.tail)
  const omitted = selected.length - shown.length
  return {
    lines: lines.length,
    text: [...(omitted > 0 ? [`… [${omitted} earlier lines omitted]`] : []), ...shown].join("\n"),
    cut: omitted > 0,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------------------------

const WorkflowField = Schema.Union([Schema.Int, Schema.String]).annotate({
  description: "Workflow id, file name (ci.yml) or display name.",
})
const RunField = GitHubShared.NumberRef.annotate({ description: "Workflow run id or run URL." })
const JobField = GitHubShared.NumberRef.annotate({ description: "Job id or job URL (…/actions/runs/1/job/2)." })

const RunSummary = Schema.Struct({
  id: Schema.Int,
  workflow: Schema.String,
  title: Schema.String,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  sha: Schema.String,
  attempt: Schema.Int,
  url: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  duration_seconds: Schema.optionalKey(Schema.Int),
})

const Step = Schema.Struct({
  number: Schema.Int,
  name: Schema.String,
  status: Schema.optionalKey(Schema.String),
  conclusion: Schema.NullOr(Schema.String),
})

const Artifact = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  bytes: Schema.Int,
  expired: Schema.Boolean,
  created_at: Schema.optionalKey(Schema.String),
  run_id: Schema.optionalKey(Schema.Int),
})

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

export function tools(deps: Deps): Tool.Info[] {
  const workflows = GitHubShared.define(deps, {
    name: "workflows",
    description:
      "List the repository's GitHub Actions workflows. inspect: true also reads each file to report whether it accepts workflow_dispatch and its inputs.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      inspect: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Read each workflow file for workflow_dispatch inputs.",
      }),
    }),
    output: Schema.Struct({
      workflows: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          file: Schema.String,
          path: Schema.String,
          state: Schema.String,
          url: Schema.String,
          dispatch: Schema.optionalKey(Schema.Boolean),
          inputs: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({
                name: Schema.String,
                required: Schema.optionalKey(Schema.Boolean),
                type: Schema.optionalKey(Schema.String),
                default: Schema.optionalKey(Schema.String),
              }),
            ),
          ),
        }),
      ),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        const all = yield* resolved.api.paginate<WorkflowData>(`/repos/${slug}/actions/workflows`, {
          key: "workflows",
          limit: 500,
        })
        return {
          workflows: yield* Effect.forEach(
            all,
            (item) =>
              Effect.gen(function* () {
                const base = {
                  id: item.id,
                  name: item.name,
                  file: path.posix.basename(item.path),
                  path: item.path,
                  state: item.state,
                  url: item.html_url,
                }
                // Dynamic workflows (Copilot, Dependabot) have no file in the repository.
                if (!input.inspect || !item.path.startsWith(".github/")) return base
                const file = yield* resolved.api
                  .json<{ content?: string }>("GET", `/repos/${slug}/contents/${item.path}`)
                  .pipe(Effect.option)
                if (file._tag === "None" || !file.value.content) return base
                return { ...base, ...dispatchInfo(GitHubShared.decodeBase64(file.value.content).toString("utf8")) }
              }),
            { concurrency: 8 },
          ),
        }
      }),
  })

  const runs = GitHubShared.define(deps, {
    name: "runs",
    description:
      "List GitHub Actions workflow runs, newest first, filtered by workflow, branch, pull request, commit, event, status or actor.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      workflow: Schema.optionalKey(WorkflowField),
      branch: Schema.optionalKey(Schema.String),
      pr: Schema.optionalKey(GitHubShared.NumberRef).annotate({
        description: "Runs for this pull request's head branch.",
      }),
      sha: Schema.optionalKey(Schema.String).annotate({ description: "Full head commit SHA." }),
      event: Schema.optionalKey(Schema.String).annotate({
        description: "push, pull_request, workflow_dispatch, schedule, …",
      }),
      status: Schema.optionalKey(Schema.String).annotate({
        description:
          "queued, in_progress, completed, success, failure, cancelled, skipped, timed_out, action_required, waiting, …",
      }),
      actor: Schema.optionalKey(Schema.String),
      limit: GitHubShared.limit(100, 20),
    }),
    output: Schema.Struct({
      runs: Schema.Array(RunSummary),
      head_sha: Schema.optionalKey(Schema.String).annotate({
        description: "The pull request's current head commit, when pr is given.",
      }),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const pull =
          input.pr === undefined
            ? undefined
            : yield* GitHubShared.pullRequest(deps, { repo: input.repo, pr: input.pr }).pipe(
                Effect.flatMap((resolved) =>
                  resolved.api
                    .json<{
                      head: { ref: string; sha: string }
                    }>("GET", `/repos/${GitHubRepo.slug(resolved.repo)}/pulls/${resolved.number}`)
                    .pipe(Effect.map((data) => ({ ...resolved, head: data.head }))),
                ),
              )
        const resolved = pull ?? (yield* GitHubShared.target(deps, input.repo))
        const slug = GitHubRepo.slug(resolved.repo)
        const workflow =
          input.workflow === undefined ? undefined : yield* workflowRef(resolved.api, slug, input.workflow)
        const items = yield* resolved.api.paginate<RunData>(
          workflow ? `/repos/${slug}/actions/workflows/${workflow}/runs` : `/repos/${slug}/actions/runs`,
          {
            key: "workflow_runs",
            limit: input.limit ?? 20,
            query: {
              branch: input.branch ?? pull?.head.ref,
              head_sha: input.sha,
              event: input.event,
              status: input.status,
              actor: input.actor,
            },
          },
        )
        return { runs: items.map(summary), ...(pull ? { head_sha: pull.head.sha } : {}) }
      }),
  })

  const run = GitHubShared.define(deps, {
    name: "run",
    description:
      "One workflow run: jobs with their failed steps, check annotations of failed jobs, artifacts, and next steps. Use logs to read a failing job.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      run: RunField,
      attempt: Schema.optionalKey(Schema.Int).annotate({ description: "Run attempt. Defaults to the latest." }),
      steps: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Include every step of every job, not only failed steps.",
      }),
    }),
    output: Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      title: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      url: Schema.String,
      event: Schema.String,
      branch: Schema.NullOr(Schema.String),
      sha: Schema.String,
      attempt: Schema.Int,
      jobs: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          status: Schema.String,
          conclusion: Schema.NullOr(Schema.String),
          url: Schema.NullOr(Schema.String),
          started_at: Schema.optionalKey(Schema.String),
          completed_at: Schema.optionalKey(Schema.String),
          failed_steps: Schema.Array(Step),
          steps: Schema.optionalKey(Schema.Array(Step)),
        }),
      ),
      annotations: Schema.Array(
        Schema.Struct({
          job: Schema.String,
          path: Schema.String,
          line: Schema.optionalKey(Schema.Int),
          level: Schema.String,
          title: Schema.optionalKey(Schema.String),
          message: Schema.String,
        }),
      ),
      artifacts: Schema.Array(Artifact),
      next: Schema.Array(Schema.String),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const located = yield* locate(deps, input.repo, input.run, "run")
        const slug = GitHubRepo.slug(located.repo)
        const api = located.api
        const [data, jobs, artifacts] = yield* Effect.all(
          [
            api.json<RunData>(
              "GET",
              input.attempt
                ? `/repos/${slug}/actions/runs/${located.id}/attempts/${input.attempt}`
                : `/repos/${slug}/actions/runs/${located.id}`,
            ),
            jobsOf(api, slug, located.id, input.attempt),
            api.paginate<ArtifactData>(`/repos/${slug}/actions/runs/${located.id}/artifacts`, {
              key: "artifacts",
              limit: 100,
            }),
          ],
          { concurrency: "unbounded" },
        )
        const failing = jobs.filter((job) => failed(job.conclusion))
        // A job id is also the id of its check run, which carries the annotations.
        const annotations = yield* Effect.forEach(
          failing,
          (job) =>
            api.paginate<AnnotationData>(`/repos/${slug}/check-runs/${job.id}/annotations`, { limit: 50 }).pipe(
              Effect.map((items) =>
                items.map((item) => ({
                  job: job.name,
                  path: item.path,
                  ...(item.start_line ? { line: item.start_line } : {}),
                  level: item.annotation_level ?? "notice",
                  ...(item.title ? { title: item.title } : {}),
                  message: GitHubShared.clip(item.message, 2000),
                })),
              ),
            ),
          { concurrency: 4 },
        )
        const step = (item: StepData) => ({
          number: item.number,
          name: item.name,
          status: item.status,
          conclusion: item.conclusion,
        })
        const base = summary(data)
        const next = [
          ...failing.map((job) => `logs({ job: ${job.id} }) for the failing job "${job.name}"`),
          ...(failing.length > 0 && data.status === "completed"
            ? [`run_action({ run: ${data.id}, action: "rerun_failed" }) to retry only the failed jobs`]
            : []),
          ...(data.status !== "completed"
            ? ["The run is still in progress; check again later or cancel with run_action."]
            : []),
          ...(data.conclusion === "action_required"
            ? [`run_action({ run: ${data.id}, action: "approve" }) to approve a fork pull request run`]
            : []),
          ...(artifacts.length > 0 ? ["artifact_download({ artifact: <id> }) to fetch an artifact"] : []),
        ]
        return {
          id: data.id,
          name: base.workflow,
          title: base.title,
          status: base.status,
          conclusion: data.conclusion,
          url: data.html_url,
          event: data.event,
          branch: data.head_branch,
          sha: base.sha,
          attempt: base.attempt,
          jobs: jobs.map((job) => ({
            id: job.id,
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            url: job.html_url,
            ...(job.started_at ? { started_at: job.started_at } : {}),
            ...(job.completed_at ? { completed_at: job.completed_at } : {}),
            failed_steps: (job.steps ?? [])
              .filter((item) => failed(item.conclusion) || item.conclusion === "cancelled")
              .map(step),
            ...(input.steps ? { steps: (job.steps ?? []).map(step) } : {}),
          })),
          annotations: annotations.flat(),
          artifacts: artifacts.map(artifact),
          next,
        }
      }),
  })

  const logs = GitHubShared.define(deps, {
    name: "logs",
    description:
      "Read GitHub Actions job logs: one job, or a run's failed jobs. Returns the tail or regex matches with context; save writes full logs to files.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      job: Schema.optionalKey(JobField),
      run: Schema.optionalKey(RunField),
      failed_only: Schema.optionalKey(Schema.Boolean).annotate({
        description: "With run: only failed jobs. Default true.",
      }),
      job_name: Schema.optionalKey(Schema.String).annotate({
        description: "With run: case-insensitive substring of the job name.",
      }),
      tail: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 }))).annotate({
        description: "Lines per job (after grep). Default 200, maximum 5000.",
      }),
      grep: Schema.optionalKey(Schema.String).annotate({
        description: "Case-insensitive regex; returns matching lines with their line numbers.",
      }),
      context: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }))).annotate({
        description: "Lines of context around grep matches. Default 3.",
      }),
      timestamps: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Keep the timestamp GitHub prefixes to each line. Default false.",
      }),
      save: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Write each job's full log to a local file and return its path.",
      }),
    }),
    output: Schema.Struct({
      jobs: Schema.Array(
        Schema.Struct({
          id: Schema.Int,
          name: Schema.String,
          conclusion: Schema.optionalKey(Schema.NullOr(Schema.String)),
          lines: Schema.Int.annotate({ description: "Lines in the downloaded log." }),
          text: Schema.String,
          truncated: Schema.Boolean.annotate({
            description: "text is not the whole log (tail, grep or download limit).",
          }),
          path: Schema.optionalKey(Schema.String),
        }),
      ),
      note: Schema.optionalKey(Schema.String),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        if (input.job === undefined && input.run === undefined)
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass job or run." })
        const grep =
          input.grep === undefined
            ? undefined
            : yield* Effect.try({
                try: () => new RegExp(input.grep ?? "", "i"),
                catch: (error) =>
                  new GitHubClient.Error({ kind: "validation", message: `Invalid grep pattern: ${String(error)}` }),
              })
        const located =
          input.job !== undefined
            ? yield* locate(deps, input.repo, input.job, "job")
            : yield* locate(deps, input.repo, input.run ?? "", "run")
        const slug = GitHubRepo.slug(located.repo)
        const api = located.api
        const selected =
          input.job !== undefined
            ? [yield* api.json<JobData>("GET", `/repos/${slug}/actions/jobs/${located.id}`)]
            : (yield* jobsOf(api, slug, located.id)).filter(
                (job) =>
                  (input.failed_only === false || failed(job.conclusion)) &&
                  (input.job_name === undefined || job.name.toLowerCase().includes(input.job_name.toLowerCase())),
              )
        if (selected.length === 0)
          return {
            jobs: [],
            note:
              input.failed_only === false
                ? "No jobs matched."
                : "No failed jobs in this run. Pass failed_only: false to read every job.",
          }
        const jobs = yield* Effect.forEach(
          selected,
          (job) =>
            Effect.gen(function* () {
              const download = yield* api.download(`/repos/${slug}/actions/jobs/${job.id}/logs`, {
                maxBytes: input.save ? SAVED_LOG_BYTES : LOG_BYTES,
                keep: "tail",
              })
              const raw = new TextDecoder().decode(download.bytes)
              const file = input.save
                ? scratch("logs", `${located.repo.owner}-${located.repo.name}-${job.id}.log`)
                : undefined
              if (file)
                yield* io("Unable to save log", () =>
                  mkdir(path.dirname(file), { recursive: true }).then(() => writeFile(file, raw)),
                )
              const shown = excerpt(raw, {
                tail: input.tail ?? 200,
                grep,
                context: input.context ?? 3,
                timestamps: input.timestamps ?? false,
              })
              return {
                id: job.id,
                name: job.name,
                conclusion: job.conclusion,
                lines: shown.lines,
                text: shown.text,
                truncated: download.truncated || shown.cut || grep !== undefined,
                ...(file ? { path: file } : {}),
              }
            }),
          { concurrency: 4 },
        )
        return { jobs }
      }),
  })

  const runAction = GitHubShared.define(deps, {
    name: "run_action",
    description:
      "Re-run, re-run failed jobs, cancel, force-cancel or approve a GitHub Actions run; rerun with job re-runs a single job.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      run: Schema.optionalKey(RunField),
      job: Schema.optionalKey(JobField),
      action: Schema.Literals(["rerun", "rerun_failed", "cancel", "force_cancel", "approve"]).annotate({
        description: "approve: allow a run from a fork pull request that awaits approval.",
      }),
      debug: Schema.optionalKey(Schema.Boolean).annotate({ description: "Enable debug logging for reruns." }),
    }),
    output: Schema.Struct({
      action: Schema.String,
      run: Schema.optionalKey(Schema.Int),
      job: Schema.optionalKey(Schema.Int),
      status: Schema.Literal("accepted"),
      message: Schema.String,
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.job !== undefined && input.action !== "rerun")
          return yield* new GitHubClient.Error({
            kind: "validation",
            message: `${input.action} applies to a run; pass run instead of job.`,
          })
        if (input.job === undefined && input.run === undefined)
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass run (or job with action rerun)." })
        const kind = input.job !== undefined ? "job" : "run"
        const located = yield* locate(deps, input.repo, input.job ?? input.run ?? "", kind)
        const slug = GitHubRepo.slug(located.repo)
        yield* GitHubShared.authorize(deps, context, "run_action", located.repo, {
          action: input.action,
          [kind]: located.id,
        })
        const debug = input.debug ? { enable_debug_logging: true } : undefined
        const request =
          kind === "job"
            ? {
                path: `/repos/${slug}/actions/jobs/${located.id}/rerun`,
                body: debug,
                message: `Job ${located.id} queued to re-run.`,
              }
            : {
                rerun: { path: "rerun", body: debug, message: `Run ${located.id} queued to re-run.` },
                rerun_failed: {
                  path: "rerun-failed-jobs",
                  body: debug,
                  message: `Failed jobs of run ${located.id} queued to re-run.`,
                },
                cancel: { path: "cancel", body: undefined, message: `Cancellation of run ${located.id} requested.` },
                force_cancel: {
                  path: "force-cancel",
                  body: undefined,
                  message: `Run ${located.id} force-cancelled; use only when cancel does not stop it.`,
                },
                approve: { path: "approve", body: undefined, message: `Run ${located.id} approved.` },
              }[input.action]
        const url = kind === "job" ? request.path : `/repos/${slug}/actions/runs/${located.id}/${request.path}`
        yield* located.api.request("POST", url, request.body ? { body: request.body } : {})
        return {
          action: input.action,
          ...(kind === "job" ? { job: located.id } : { run: located.id }),
          status: "accepted" as const,
          message: `${request.message} Check progress with run({ run: ${kind === "run" ? located.id : "<run id>"} }).`,
        }
      }),
  })

  const dispatch = GitHubShared.define(deps, {
    name: "dispatch",
    description:
      "Trigger a workflow_dispatch workflow on a branch or tag with inputs, and return the run it started. Use workflows inspect to see inputs.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      workflow: WorkflowField,
      ref: Schema.optionalKey(Schema.String).annotate({
        description: "Branch or tag. Defaults to the default branch.",
      }),
      inputs: Schema.optionalKey(
        Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
      ),
    }),
    output: Schema.Struct({
      workflow: Schema.String,
      ref: Schema.String,
      run_id: Schema.optionalKey(Schema.Int),
      url: Schema.optionalKey(Schema.String),
      note: Schema.optionalKey(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const slug = GitHubRepo.slug(resolved.repo)
        const api = resolved.api
        const id = yield* workflowRef(api, slug, input.workflow)
        const workflow = yield* api.json<WorkflowData>("GET", `/repos/${slug}/actions/workflows/${id}`)
        const ref =
          input.ref ??
          (yield* api
            .json<{ default_branch: string }>("GET", `/repos/${slug}`)
            .pipe(Effect.map((repo) => repo.default_branch)))
        yield* GitHubShared.authorize(deps, context, "dispatch", resolved.repo, { workflow: workflow.path, ref })
        const started = yield* Clock.currentTimeMillis
        const response = yield* api.request<
          { workflow_run_id?: number; run_url?: string; html_url?: string } | undefined
        >("POST", `/repos/${slug}/actions/workflows/${workflow.id}/dispatches`, {
          body: {
            ref,
            ...(input.inputs
              ? { inputs: Object.fromEntries(Object.entries(input.inputs).map(([key, value]) => [key, String(value)])) }
              : {}),
            return_run_details: true,
          },
        })
        const name = workflow.name
        if (response.data?.workflow_run_id)
          return {
            workflow: name,
            ref,
            run_id: response.data.workflow_run_id,
            ...(response.data.html_url ? { url: response.data.html_url } : {}),
          }
        // Servers without return_run_details answer 204; find the run it started. Allow for clock skew.
        const since = new Date(started - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z")
        const branch = ref.replace(/^refs\/(heads|tags)\//, "")
        const lookup = api
          .json<{ workflow_runs: RunData[] }>("GET", `/repos/${slug}/actions/workflows/${workflow.id}/runs`, {
            query: { event: "workflow_dispatch", branch, created: `>=${since}`, per_page: 5 },
          })
          .pipe(
            Effect.map(
              (data) =>
                data.workflow_runs
                  .filter((item) => Date.parse(item.created_at) >= started - 60_000)
                  .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0],
            ),
          )
        const found = yield* Effect.gen(function* () {
          for (const delay of [0, 2000, 3000, 5000]) {
            if (delay > 0) yield* Effect.sleep(delay)
            const item = yield* lookup
            if (item) return item
          }
          return undefined
        })
        if (found) return { workflow: name, ref, run_id: found.id, url: found.html_url }
        return {
          workflow: name,
          ref,
          note: `Dispatched, but the run is not listed yet. Find it with runs({ workflow: ${workflow.id}, event: "workflow_dispatch", branch: "${branch}" }).`,
        }
      }),
  })

  const artifacts = GitHubShared.define(deps, {
    name: "artifacts",
    description: "List GitHub Actions artifacts of a run, or of the repository (optionally by name), newest first.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      run: Schema.optionalKey(RunField),
      name: Schema.optionalKey(Schema.String).annotate({ description: "Exact artifact name." }),
      limit: GitHubShared.limit(100, 30),
    }),
    output: Schema.Struct({ artifacts: Schema.Array(Artifact) }),
    execute: (input) =>
      Effect.gen(function* () {
        const located = input.run === undefined ? undefined : yield* locate(deps, input.repo, input.run, "run")
        const resolved = located ?? (yield* GitHubShared.target(deps, input.repo))
        const slug = GitHubRepo.slug(resolved.repo)
        const items = yield* resolved.api.paginate<ArtifactData>(
          located ? `/repos/${slug}/actions/runs/${located.id}/artifacts` : `/repos/${slug}/actions/artifacts`,
          { key: "artifacts", limit: input.limit ?? 30, ...(input.name ? { query: { name: input.name } } : {}) },
        )
        return { artifacts: items.map(artifact) }
      }),
  })

  const artifactDownload = GitHubShared.define(deps, {
    name: "artifact_download",
    description:
      "Download a GitHub Actions artifact by id, or by name within a run, and unzip it to a local directory. Returns the extracted file paths.",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      artifact: Schema.optionalKey(Schema.Int).annotate({ description: "Artifact id." }),
      name: Schema.optionalKey(Schema.String).annotate({
        description: "Artifact name; with run, looked up in that run, else the newest.",
      }),
      run: Schema.optionalKey(RunField),
      path: Schema.optionalKey(Schema.String).annotate({
        description: "Destination directory, relative to the working directory. Defaults to a temporary directory.",
      }),
      extract: Schema.optionalKey(Schema.Boolean).annotate({
        description: "Unzip the artifact. Default true; false keeps the zip.",
      }),
    }),
    output: Schema.Struct({
      id: Schema.Int,
      name: Schema.String,
      path: Schema.String,
      zip: Schema.optionalKey(Schema.String),
      files: Schema.optionalKey(Schema.Array(Schema.String)),
      bytes: Schema.Int,
      note: Schema.optionalKey(Schema.String),
    }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.artifact === undefined && input.name === undefined)
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass artifact (id) or name." })
        const located = input.run === undefined ? undefined : yield* locate(deps, input.repo, input.run, "run")
        const resolved = located ?? (yield* GitHubShared.target(deps, input.repo))
        const slug = GitHubRepo.slug(resolved.repo)
        const api = resolved.api
        const meta =
          input.artifact !== undefined
            ? yield* api.json<ArtifactData>("GET", `/repos/${slug}/actions/artifacts/${input.artifact}`)
            : yield* api
                .paginate<ArtifactData>(
                  located ? `/repos/${slug}/actions/runs/${located.id}/artifacts` : `/repos/${slug}/actions/artifacts`,
                  { key: "artifacts", limit: 100, query: { name: input.name } },
                )
                .pipe(
                  Effect.flatMap((items) => {
                    const match = items.find((item) => item.name === input.name && !item.expired)
                    if (match) return Effect.succeed(match)
                    return Effect.fail(
                      new GitHubClient.Error({
                        kind: "not_found",
                        message: `No unexpired artifact named ${input.name}${located ? ` in run ${located.id}` : ""}.`,
                        hint: "List them with artifacts.",
                      }),
                    )
                  }),
                )
        if (meta.expired)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            message: `Artifact ${meta.id} (${meta.name}) has expired.`,
          })
        const download = yield* api.download(`/repos/${slug}/actions/artifacts/${meta.id}/zip`, {
          maxBytes: ARTIFACT_BYTES,
        })
        if (download.truncated)
          return yield* new GitHubClient.Error({
            kind: "unsupported",
            message: `Artifact ${meta.name} is larger than ${ARTIFACT_BYTES / 1024 / 1024} MB.`,
            hint: `Download it with \`gh run download --name ${meta.name}\`.`,
          })
        const directory = input.path
          ? yield* GitHubShared.writable(deps, context, input.path)
          : scratch("artifacts", resolved.repo.host, resolved.repo.owner, resolved.repo.name, String(meta.id))
        yield* io("Unable to create directory", () => mkdir(directory, { recursive: true }))
        const result = { id: meta.id, name: meta.name, path: directory, bytes: download.bytes.byteLength }
        if (input.extract === false) {
          const zip = path.join(directory, `${meta.name}.zip`)
          yield* io("Unable to write artifact", () => writeFile(zip, download.bytes))
          return { ...result, zip }
        }
        const zip = scratch("artifacts", `${meta.id}.zip`)
        yield* io("Unable to write artifact", () =>
          mkdir(path.dirname(zip), { recursive: true }).then(() => writeFile(zip, download.bytes)),
        )
        const failure = yield* deps.process
          .run(ChildProcess.make("unzip", ["-o", "-q", zip, "-d", directory], { extendEnv: true, stdin: "ignore" }), {
            timeout: "5 minutes",
          })
          .pipe(
            Effect.flatMap(AppProcess.requireSuccess),
            Effect.as(undefined),
            Effect.catch((error) => Effect.succeed(error.message)),
          )
        if (failure !== undefined)
          return {
            ...result,
            zip,
            note: `Could not extract with unzip (${failure.trim().slice(0, 300)}); the zip is kept.`,
          }
        yield* io("Unable to remove zip", () => rm(zip, { force: true }))
        const entries = yield* io("Unable to list files", () =>
          readdir(directory, { recursive: true, withFileTypes: true }),
        )
        const files = entries
          .filter((entry) => entry.isFile())
          .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
          .sort()
        return {
          ...result,
          files: files.slice(0, 200),
          ...(files.length > 200 ? { note: `${files.length} files; showing the first 200.` } : {}),
        }
      }),
  })

  return [workflows, runs, run, logs, runAction, dispatch, artifacts, artifactDownload]
}
