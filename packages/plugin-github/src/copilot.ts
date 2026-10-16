export * as GitHubCopilot from "./copilot.js"

/** Login GitHub accepts when requesting a Copilot review through the REST API. */
export const REVIEWER = "copilot-pull-request-reviewer[bot]"

export type AuthorKind = "copilot" | "bot" | "human"

const REVIEWER_LOGINS = /^(copilot|copilot-pull-request-reviewer)(\[bot\])?$/i

/** Classifies an author. Copilot's reviewer appears as `Copilot` in REST and `copilot-pull-request-reviewer` in GraphQL. */
export function authorKind(login: string | undefined | null, type?: string | null): AuthorKind {
  if (!login) return "bot"
  if (REVIEWER_LOGINS.test(login)) return "copilot"
  if (type === "Bot" || /\[bot\]$/i.test(login) || /^copilot-/i.test(login)) return "bot"
  return "human"
}

export type Verdict = "approve" | "changes" | "closer_look" | "clean" | "comments" | "unknown"

export interface ListedFinding {
  readonly title: string
  readonly severity?: string
  /** Database ID of the review comment that carries the finding, parsed from its `discussion_r` link. */
  readonly commentID?: number
  readonly new: boolean
}

export type BodyFindingKind = "low_confidence" | "previously_missed" | "outside_diff" | "other"

/** A finding that exists only in the review body, with no review thread to reply to or resolve. */
export interface BodyFinding {
  readonly kind: BodyFindingKind
  readonly title?: string
  readonly path?: string
  readonly line?: number
  readonly endLine?: number
  readonly severity?: string
  readonly body: string
}

export interface Review {
  readonly verdict: Verdict
  readonly headline?: string
  readonly summary?: string
  readonly open?: number
  readonly resolved?: number
  readonly generated?: number
  readonly findings: ReadonlyArray<ListedFinding>
  readonly body: ReadonlyArray<BodyFinding>
}

/** Parses a Copilot review body. Tolerates the current overview format and the older "Pull request overview" one. */
export function parseReview(input: string | undefined | null): Review {
  const body = clean(input ?? "")
  const headline = /^#{2,3}\s+(?:[^\p{L}\s]+\s*)?([^\n]+?)\s*$/mu.exec(body)?.[1]
  const sections = details(body)
  const open = number(/(?:\*\*|<strong>)(\d+) open findings?(?:\*\*|<\/strong>)/.exec(body)?.[1])
  const resolved = number(/(\d+) resolved since last review/.exec(body)?.[1])
  const generatedMatch =
    /generated (no(?: new)?|\d+)(?: new)? comments?/i.exec(body) ?? /Comments generated:\*\*\s*(\d+)/i.exec(body)
  const generated = generatedMatch ? (/^no/i.test(generatedMatch[1]) ? 0 : Number(generatedMatch[1])) : undefined
  const findings = sections
    .filter((section) => /open findings?/i.test(section.summary))
    .flatMap((section) => listed(section.content))
  const bodyFindings = sections.flatMap((section): BodyFinding[] => {
    const kind = bodyKind(section.summary)
    if (!kind) return []
    const nested = section.children.flatMap((child) => nestedFinding(kind, child))
    if (nested.length > 0) return nested
    return boldFindings(kind, section.content)
  })
  return {
    verdict: verdict(headline, { open, generated, findings: findings.length + bodyFindings.length }),
    ...(headline ? { headline } : {}),
    ...(summaryText(body, headline) ? { summary: summaryText(body, headline) } : {}),
    ...(open !== undefined ? { open } : {}),
    ...(resolved !== undefined ? { resolved } : {}),
    ...(generated !== undefined ? { generated } : {}),
    findings,
    body: bodyFindings,
  }
}

function verdict(
  headline: string | undefined,
  counts: { open?: number; generated?: number; findings: number },
): Verdict {
  if (headline && /approv/i.test(headline)) return "approve"
  if (headline && /changes/i.test(headline)) return "changes"
  if (headline && /closer look/i.test(headline)) return "closer_look"
  if (counts.open === 0 || counts.generated === 0) return counts.findings === 0 ? "clean" : "comments"
  if ((counts.open ?? 0) > 0 || (counts.generated ?? 0) > 0 || counts.findings > 0) return "comments"
  return "unknown"
}

function bodyKind(summary: string): BodyFindingKind | undefined {
  if (/low confidence/i.test(summary)) return "low_confidence"
  if (/previously missed/i.test(summary)) return "previously_missed"
  if (/outside (?:of )?(?:the )?(?:diff|changed)|unchanged|not part of the diff/i.test(summary)) return "outside_diff"
  if (
    /open findings?|resolved since|what changed|pull request overview|file summar|review details|summary per file/i.test(
      summary,
    )
  )
    return undefined
  if (/\(\d+\)/.test(summary) && /comment|finding|suggest/i.test(summary)) return "other"
  return undefined
}

function nestedFinding(kind: BodyFindingKind, section: Section): BodyFinding[] {
  const title = section.summary.trim()
  const location = /^`([^`\n]+?):(\d+)(?:[-–](\d+))?`/m.exec(section.content)
  const text = section.content.replace(location?.[0] ?? "", "").trim()
  if (!text && !location) return []
  return [
    {
      kind,
      ...(title ? { title } : {}),
      ...(location ? { path: location[1], line: Number(location[2]) } : {}),
      ...(location?.[3] ? { endLine: Number(location[3]) } : {}),
      ...(section.severity ? { severity: section.severity } : {}),
      body: text,
    },
  ]
}

function boldFindings(kind: BodyFindingKind, content: string): BodyFinding[] {
  const header = /^\*\*([^*\n]+?):(\d+)(?:[-–](\d+))?\*\*\s*$/gm
  const matches = [...content.matchAll(header)]
  return matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length
    const end = matches[index + 1]?.index ?? content.length
    const text = content
      .slice(start, end)
      .split("\n")
      .map((line) => line.replace(/^\s*[*-]\s+/, ""))
      .join("\n")
      .trim()
    return {
      kind,
      path: match[1].trim(),
      line: Number(match[2]),
      ...(match[3] ? { endLine: Number(match[3]) } : {}),
      body: text,
    }
  })
}

function listed(content: string): ListedFinding[] {
  return content.split("\n").flatMap((line) => {
    const match = /^\s*[-*]\s+(?:\[(\w+)\]\s*)?(.*?)\[([^\]]+)\]\(([^)]*)\)(.*)$/.exec(line)
    if (!match) return []
    const severity = match[1] ?? /(\w+) severity/i.exec(match[2])?.[1]
    const comment = /discussion_r(\d+)/.exec(match[4])?.[1]
    return [
      {
        title: match[3].trim(),
        ...(severity ? { severity: severity.toLowerCase() } : {}),
        ...(comment ? { commentID: Number(comment) } : {}),
        new: /\bNew\b/.test(match[5]),
      },
    ]
  })
}

function summaryText(body: string, headline: string | undefined) {
  if (!headline) return undefined
  const after = body.slice(body.indexOf(headline) + headline.length)
  return after
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith("<") && !part.startsWith("*Once") && !/^\*\*\d+ open/.test(part))
}

interface Section {
  readonly summary: string
  readonly severity?: string
  readonly content: string
  readonly children: Section[]
}

// Copilot nests `<details>` blocks: a section such as "Previously missed (1)" holds one block per finding.
function details(body: string): Section[] {
  const tokens = [...body.matchAll(/<details[^>]*>|<\/details>/g)]
  const roots: Section[] = []
  const stack: { start: number; children: Section[] }[] = []
  for (const token of tokens) {
    const index = token.index ?? 0
    if (token[0].startsWith("<details")) {
      stack.push({ start: index + token[0].length, children: [] })
      continue
    }
    const open = stack.pop()
    if (!open) continue
    const inner = body.slice(open.start, index)
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(inner)
    const raw = summary?.[1] ?? ""
    const childText = open.children.length > 0 ? inner.slice(0, inner.indexOf("<details")) : inner
    const text = raw
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim()
    // `clean` has already turned Copilot's severity badge into a `[Medium]` prefix.
    const badge = /^\[(\w+)\]\s*/.exec(text)
    const section: Section = {
      summary: badge ? text.slice(badge[0].length) : text,
      ...(badge ? { severity: badge[1].toLowerCase() } : {}),
      content: childText.replace(summary?.[0] ?? "", "").trim(),
      children: open.children,
    }
    const parent = stack.at(-1)
    if (parent) parent.children.push(section)
    else roots.push(section)
  }
  return roots
}

// Copilot inserts zero-width spaces after path separators so long paths wrap; they break path matching.
function clean(text: string) {
  return (
    text
      .replace(/\u200b/g, "")
      // Inspect one picture block at a time, so a badge-less picture cannot swallow text up to a later badge.
      .replace(/<picture>[\s\S]*?<\/picture>/g, (block) => {
        const severity = /<img[^>]*alt="(\w+) severity"/i.exec(block)?.[1]
        return severity ? `[${severity}]` : ""
      })
      .replace(/\r\n/g, "\n")
  )
}

function number(value: string | undefined) {
  return value === undefined ? undefined : Number(value)
}

/** Removes Copilot's markup so a comment body reads as plain text for a model. */
export function plain(text: string) {
  return clean(text)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:details|summary|sub|strong|b|em|br)[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export type ReviewState = "reviewed" | "in_progress" | "requested" | "stale" | "none"

export interface CopilotReviewRef {
  readonly id: number
  readonly commit: string
  readonly at: string
  readonly body: string
}

export interface TimelineEvent {
  readonly event: string
  readonly at: string
  readonly reviewer?: string
}

export interface State {
  readonly state: ReviewState
  /** When the current state began: the request, the start of work, or the latest review. */
  readonly since?: string
  readonly latest?: CopilotReviewRef
  readonly rounds: number
  /** True when a request or review has not progressed for longer than GitHub normally takes. */
  readonly stuck: boolean
}

export const STUCK_REQUEST_MS = 10 * 60_000
export const STUCK_WORK_MS = 30 * 60_000

/** Derives Copilot's review progress on a pull request from its reviews, timeline events and pending reviewers. */
export function state(input: {
  readonly head: string
  readonly reviews: ReadonlyArray<CopilotReviewRef>
  readonly events: ReadonlyArray<TimelineEvent>
  readonly pending: boolean
  readonly now: number
}): State {
  const latest = input.reviews.toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at))[0]
  const reviewed = latest ? Date.parse(latest.at) : 0
  const last = (predicate: (event: TimelineEvent) => boolean) =>
    Math.max(0, ...input.events.filter(predicate).map((event) => Date.parse(event.at)))
  const copilot = (event: TimelineEvent) => authorKind(event.reviewer) === "copilot"
  const requested = last((event) => event.event === "review_requested" && copilot(event))
  const removed = last((event) => event.event === "review_request_removed" && copilot(event))
  const started = last((event) => event.event === "copilot_work_started")
  const finished = last(
    (event) => event.event === "copilot_work_finished" || event.event === "copilot_work_finished_failure",
  )
  const rounds = input.reviews.length
  const base = { rounds, ...(latest ? { latest } : {}) }
  if (started > reviewed && started > finished)
    return { ...base, state: "in_progress", since: iso(started), stuck: input.now - started > STUCK_WORK_MS }
  const pendingSince = Math.max(requested, started)
  // Work that ended without a review (copilot_work_finished_failure) also ends the request.
  if (input.pending || (requested > reviewed && requested > removed && requested > finished))
    return {
      ...base,
      state: "requested",
      ...(pendingSince ? { since: iso(pendingSince) } : {}),
      stuck: pendingSince > 0 && input.now - pendingSince > STUCK_REQUEST_MS,
    }
  if (latest)
    return { ...base, state: latest.commit === input.head ? "reviewed" : "stale", since: latest.at, stuck: false }
  return { ...base, state: "none", stuck: false }
}

function iso(time: number) {
  return new Date(time).toISOString()
}
