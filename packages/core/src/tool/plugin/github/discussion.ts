export * as GitHubDiscussions from "./discussion.js"

import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { GitHubClient } from "./client.js"
import { GitHubCopilot } from "./copilot.js"
import { GitHubRepo } from "./repo.js"
import { GitHubShared } from "./shared.js"

type Deps = GitHubShared.Deps

const BODY_MAX = 8000
const COMMENT_MAX = 2000

const Author = GitHubShared.Author

const DiscussionRef = GitHubShared.NumberRef.annotate({ description: "Discussion number, #number, owner/repo#number or URL." })

interface GqlAuthor {
  readonly login: string
  readonly __typename?: string
}

const authorOf = (author: GqlAuthor | null | undefined) => ({
  login: author?.login ?? "ghost",
  kind: GitHubCopilot.authorKind(author?.login, author?.__typename),
})

const quote = (value: string) => (/[\s"]/.test(value) ? `"${value.replace(/"/g, "")}"` : value)

// ---------------------------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------------------------

interface CategoryNode {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly isAnswerable: boolean
}

interface RepoData {
  readonly id: string
  readonly discussionCategories: { readonly nodes: ReadonlyArray<CategoryNode> }
}

const CATEGORY_FIELDS = `discussionCategories(first: 50) { nodes { id name slug isAnswerable } }`

const REPO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id ${CATEGORY_FIELDS} }
}`

const categoryList = (repo: RepoData) =>
  repo.discussionCategories.nodes.map((category) => ({ name: category.name, slug: category.slug, answerable: category.isAnswerable }))

/** Finds a category by slug or name, case-insensitively; a miss lists what exists so the model can retry. */
export function resolveCategory(categories: ReadonlyArray<CategoryNode>, wanted: string) {
  const key = wanted.trim().toLowerCase()
  const found = categories.find((category) => category.slug.toLowerCase() === key || category.name.toLowerCase() === key)
  if (found) return Effect.succeed(found)
  return Effect.fail(
    new GitHubClient.Error({
      kind: "validation",
      message: `No discussion category "${wanted}". Available: ${categories.length ? categories.map((category) => `${category.name} (${category.slug})`).join(", ") : "none; discussions may be disabled"}.`,
    }),
  )
}

const repository = Effect.fn("GitHubDiscussions.repository")(function* (target: GitHubShared.Target) {
  const data = yield* target.api.graphql<{ repository: RepoData | null }>(REPO_QUERY, { owner: target.repo.owner, name: target.repo.name })
  if (!data.repository)
    return yield* new GitHubClient.Error({ kind: "not_found", message: `Repository ${GitHubRepo.slug(target.repo)} not found` })
  return data.repository
})

// ---------------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------------

interface DiscussionSummary {
  readonly number?: number
  readonly title: string
  readonly url: string
  readonly category: { readonly name: string }
  readonly author: GqlAuthor | null
  readonly isAnswered: boolean | null
  readonly closed: boolean
  readonly comments: { readonly totalCount: number }
  readonly updatedAt: string
}

const SUMMARY_FIELDS = `number title url isAnswered closed updatedAt category { name } author { login __typename } comments { totalCount }`

const SEARCH_QUERY = `query($query: String!, $first: Int!) {
  search(type: DISCUSSION, query: $query, first: $first) { discussionCount nodes { ... on Discussion { ${SUMMARY_FIELDS} } } }
}`

const LIST_QUERY = `query($owner: String!, $name: String!, $first: Int!, $categoryId: ID, $answered: Boolean) {
  repository(owner: $owner, name: $name) {
    discussions(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }, categoryId: $categoryId, answered: $answered) {
      totalCount nodes { ${SUMMARY_FIELDS} }
    }
  }
}`

interface CommentNode {
  readonly id: string
  readonly author: GqlAuthor | null
  readonly body: string
  readonly createdAt: string
  readonly url: string
  readonly isAnswer?: boolean
  readonly isMinimized: boolean
  readonly replies?: { readonly totalCount: number; readonly nodes: ReadonlyArray<CommentNode> }
}

interface DiscussionData {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly body: string
  readonly url: string
  readonly closed: boolean
  readonly stateReason: string | null
  readonly locked: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly author: GqlAuthor | null
  readonly category: { readonly name: string; readonly slug: string; readonly isAnswerable: boolean }
  readonly answer: { readonly id: string; readonly author: GqlAuthor | null } | null
  readonly comments: { readonly totalCount: number; readonly nodes: ReadonlyArray<CommentNode> }
}

const COMMENT_FIELDS = `id body createdAt url isMinimized author { login __typename }`

const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!, $commentLimit: Int!) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      id number title body url closed stateReason locked createdAt updatedAt
      author { login __typename }
      category { name slug isAnswerable }
      answer { id author { login __typename } }
      comments(first: $commentLimit) {
        totalCount
        nodes { ${COMMENT_FIELDS} isAnswer replies(first: 20) { totalCount nodes { ${COMMENT_FIELDS} } } }
      }
    }
  }
}`

const DISCUSSION_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { discussion(number: $number) { id url } ${CATEGORY_FIELDS} }
}`

// ---------------------------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------------------------

const Category = Schema.Struct({ name: Schema.String, slug: Schema.String, answerable: Schema.Boolean })

const Summary = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  url: Schema.String,
  category: Schema.String,
  author: Author,
  answered: Schema.Boolean,
  closed: Schema.Boolean,
  comments: Schema.Int,
  updated_at: Schema.String,
})

const Reply = Schema.Struct({
  id: Schema.String,
  author: Author,
  body: Schema.String,
  created_at: Schema.String,
  url: Schema.String,
  hidden: Schema.optionalKey(Schema.Boolean),
})

const Comment = Schema.Struct({
  id: Schema.String.annotate({ description: "Node id; pass as reply_to to comment, or as answer to discussion_update." }),
  author: Author,
  body: Schema.String,
  created_at: Schema.String,
  url: Schema.String,
  is_answer: Schema.Boolean,
  hidden: Schema.optionalKey(Schema.Boolean),
  replies_total: Schema.Int,
  replies: Schema.Array(Reply),
})

const reply = (node: CommentNode) => ({
  id: node.id,
  author: authorOf(node.author),
  body: GitHubShared.clip(GitHubCopilot.plain(node.body), COMMENT_MAX),
  created_at: node.createdAt,
  url: node.url,
  ...(node.isMinimized ? { hidden: true } : {}),
})

export function tools(deps: Deps): Tool.Info[] {
  const discussions = GitHubShared.define(deps, {
    name: "discussions",
    description: [
      "List a repository's discussions, most recently updated first, or search them with query. Also returns the categories.",
      "category takes a name or slug.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      category: Schema.optionalKey(Schema.String),
      answered: Schema.optionalKey(Schema.Boolean),
      query: Schema.optionalKey(Schema.String).annotate({ description: "Free text or GitHub search qualifiers." }),
      limit: GitHubShared.limit(100, 20),
    }),
    output: Schema.Struct({
      total: Schema.optionalKey(Schema.Int),
      items: Schema.Array(Summary),
      categories: Schema.Array(Category),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const repo = yield* repository(resolved)
        const category = input.category === undefined ? undefined : yield* resolveCategory(repo.discussionCategories.nodes, input.category)
        const first = input.limit ?? 20
        const list = input.query?.trim()
          ? yield* resolved.api
              .graphql<{ search: { discussionCount: number; nodes: ReadonlyArray<DiscussionSummary | null> } }>(SEARCH_QUERY, {
                query: [
                  `repo:${GitHubRepo.slug(resolved.repo)}`,
                  ...(category ? [`category:${quote(category.name)}`] : []),
                  ...(input.answered === undefined ? [] : [input.answered ? "is:answered" : "is:unanswered"]),
                  input.query.trim(),
                ].join(" "),
                first,
              })
              .pipe(Effect.map((data) => ({ total: data.search.discussionCount, nodes: data.search.nodes })))
          : yield* resolved.api
              .graphql<{ repository: { discussions: { totalCount: number; nodes: ReadonlyArray<DiscussionSummary | null> } } | null }>(
                LIST_QUERY,
                {
                  owner: resolved.repo.owner,
                  name: resolved.repo.name,
                  first,
                  ...(category ? { categoryId: category.id } : {}),
                  ...(input.answered === undefined ? {} : { answered: input.answered }),
                },
              )
              .pipe(
                Effect.map((data) => ({
                  total: data.repository?.discussions.totalCount ?? 0,
                  nodes: data.repository?.discussions.nodes ?? [],
                })),
              )
        return {
          total: list.total,
          items: list.nodes.flatMap((node) =>
            node?.number === undefined
              ? []
              : [
                  {
                    number: node.number,
                    title: node.title,
                    url: node.url,
                    category: node.category.name,
                    author: authorOf(node.author),
                    answered: node.isAnswered === true,
                    closed: node.closed,
                    comments: node.comments.totalCount,
                    updated_at: node.updatedAt,
                  },
                ],
          ),
          categories: categoryList(repo),
        }
      }),
  })

  const discussion = GitHubShared.define(deps, {
    name: "discussion",
    description: "Read one discussion with its body, category, answer and comments with their replies (ids feed comment and discussion_update).",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      discussion: DiscussionRef,
      comment_limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))).annotate({
        description: "Top-level comments to include, oldest first. Default 50, maximum 100.",
      }),
    }),
    output: Schema.Struct({
      repo: Schema.String,
      number: Schema.Int,
      title: Schema.String,
      url: Schema.String,
      category: Schema.Struct({ name: Schema.String, slug: Schema.String, answerable: Schema.Boolean }),
      author: Author,
      body: Schema.String,
      closed: Schema.Boolean,
      state_reason: Schema.optionalKey(Schema.String),
      locked: Schema.Boolean,
      created_at: Schema.String,
      updated_at: Schema.String,
      answer: Schema.optionalKey(Schema.Struct({ id: Schema.String, author: Author })),
      comments_total: Schema.Int,
      comments: Schema.Array(Comment),
    }),
    execute: (input) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.numbered(deps, { repo: input.repo, ref: input.discussion })
        const slug = GitHubRepo.slug(resolved.repo)
        const data = yield* resolved.api.graphql<{ repository: { discussion: DiscussionData | null } | null }>(DISCUSSION_QUERY, {
          owner: resolved.repo.owner,
          name: resolved.repo.name,
          number: resolved.number,
          commentLimit: input.comment_limit ?? 50,
        })
        const found = data.repository?.discussion
        if (!found) return yield* new GitHubClient.Error({ kind: "not_found", message: `Discussion ${slug}#${resolved.number} not found` })
        return {
          repo: slug,
          number: found.number,
          title: found.title,
          url: found.url,
          category: { name: found.category.name, slug: found.category.slug, answerable: found.category.isAnswerable },
          author: authorOf(found.author),
          body: GitHubShared.clip(GitHubCopilot.plain(found.body), BODY_MAX),
          closed: found.closed,
          ...(found.stateReason ? { state_reason: found.stateReason.toLowerCase() } : {}),
          locked: found.locked,
          created_at: found.createdAt,
          updated_at: found.updatedAt,
          ...(found.answer ? { answer: { id: found.answer.id, author: authorOf(found.answer.author) } } : {}),
          comments_total: found.comments.totalCount,
          comments: found.comments.nodes.map((node) => ({
            ...reply(node),
            is_answer: node.isAnswer === true,
            replies_total: node.replies?.totalCount ?? 0,
            replies: (node.replies?.nodes ?? []).map(reply),
          })),
        }
      }),
  })

  const discussionCreate = GitHubShared.define(deps, {
    name: "discussion_create",
    description: "Start a discussion in a category (name or slug; the error lists the categories when it does not match).",
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      title: Schema.String,
      body: Schema.String,
      category: Schema.String,
    }),
    output: Schema.Struct({ number: Schema.Int, url: Schema.String }),
    execute: (input, context) =>
      Effect.gen(function* () {
        const resolved = yield* GitHubShared.target(deps, input.repo)
        const repo = yield* repository(resolved)
        const category = yield* resolveCategory(repo.discussionCategories.nodes, input.category)
        yield* GitHubShared.authorize(deps, context, "discussion_create", resolved.repo)
        const created = yield* resolved.api.graphql<{ createDiscussion: { discussion: { number: number; url: string } } }>(
          `mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) { createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) { discussion { number url } } }`,
          { repositoryId: repo.id, categoryId: category.id, title: input.title, body: input.body },
        )
        return { number: created.createDiscussion.discussion.number, url: created.createDiscussion.discussion.url }
      }),
  })

  const discussionUpdate = GitHubShared.define(deps, {
    name: "discussion_update",
    description: [
      "Edit a discussion: title, body, category, close with a reason or reopen, mark or unmark an answer, lock or unlock.",
      "answer and unanswer take a discussion comment node id from discussion.",
    ].join("\n"),
    input: Schema.Struct({
      repo: GitHubShared.RepoField,
      discussion: DiscussionRef,
      title: Schema.optionalKey(Schema.String),
      body: Schema.optionalKey(Schema.String),
      category: Schema.optionalKey(Schema.String).annotate({ description: "Move to this category (name or slug)." }),
      close: Schema.optionalKey(Schema.Literals(["resolved", "outdated", "duplicate"])),
      reopen: Schema.optionalKey(Schema.Boolean),
      answer: Schema.optionalKey(Schema.String),
      unanswer: Schema.optionalKey(Schema.String),
      lock: Schema.optionalKey(Schema.Boolean),
    }),
    output: Schema.Struct({ number: Schema.Int, url: Schema.String, changed: Schema.Array(Schema.String) }),
    execute: (input, context) =>
      Effect.gen(function* () {
        if (input.close !== undefined && input.reopen === true)
          return yield* new GitHubClient.Error({ kind: "validation", message: "Pass close or reopen, not both." })
        const editing = input.title !== undefined || input.body !== undefined || input.category !== undefined
        if (
          !editing &&
          input.close === undefined &&
          input.reopen !== true &&
          input.answer === undefined &&
          input.unanswer === undefined &&
          input.lock === undefined
        )
          return yield* new GitHubClient.Error({ kind: "validation", message: "Nothing to change." })
        const resolved = yield* GitHubShared.numbered(deps, { repo: input.repo, ref: input.discussion })
        const api = resolved.api
        const data = yield* api.graphql<{
          repository: (Omit<RepoData, "id"> & { discussion: { id: string; url: string } | null }) | null
        }>(DISCUSSION_ID_QUERY, { owner: resolved.repo.owner, name: resolved.repo.name, number: resolved.number })
        const found = data.repository?.discussion
        if (!data.repository || !found)
          return yield* new GitHubClient.Error({
            kind: "not_found",
            message: `Discussion ${GitHubRepo.slug(resolved.repo)}#${resolved.number} not found`,
          })
        const category =
          input.category === undefined ? undefined : yield* resolveCategory(data.repository.discussionCategories.nodes, input.category)
        yield* GitHubShared.authorize(deps, context, "discussion_update", resolved.repo)

        const changed: string[] = []
        if (editing) {
          yield* api.graphql(
            `mutation($discussionId: ID!, $title: String, $body: String, $categoryId: ID) { updateDiscussion(input: { discussionId: $discussionId, title: $title, body: $body, categoryId: $categoryId }) { discussion { id } } }`,
            {
              discussionId: found.id,
              ...(input.title !== undefined ? { title: input.title } : {}),
              ...(input.body !== undefined ? { body: input.body } : {}),
              ...(category ? { categoryId: category.id } : {}),
            },
          )
          if (input.title !== undefined) changed.push("title")
          if (input.body !== undefined) changed.push("body")
          if (category) changed.push(`category: ${category.name}`)
        }
        if (input.reopen === true) {
          yield* api.graphql(`mutation($discussionId: ID!) { reopenDiscussion(input: { discussionId: $discussionId }) { discussion { closed } } }`, {
            discussionId: found.id,
          })
          changed.push("reopened")
        }
        if (input.answer !== undefined) {
          yield* api.graphql(`mutation($id: ID!) { markDiscussionCommentAsAnswer(input: { id: $id }) { discussion { id } } }`, { id: input.answer })
          changed.push(`answer: ${input.answer}`)
        }
        if (input.unanswer !== undefined) {
          yield* api.graphql(`mutation($id: ID!) { unmarkDiscussionCommentAsAnswer(input: { id: $id }) { discussion { id } } }`, {
            id: input.unanswer,
          })
          changed.push(`unanswered: ${input.unanswer}`)
        }
        if (input.close !== undefined) {
          yield* api.graphql(
            `mutation($discussionId: ID!, $reason: DiscussionCloseReason!) { closeDiscussion(input: { discussionId: $discussionId, reason: $reason }) { discussion { closed } } }`,
            { discussionId: found.id, reason: input.close.toUpperCase() },
          )
          changed.push(`closed: ${input.close}`)
        }
        if (input.lock !== undefined) {
          yield* api.graphql(
            input.lock
              ? `mutation($id: ID!) { lockLockable(input: { lockableId: $id }) { lockedRecord { locked } } }`
              : `mutation($id: ID!) { unlockLockable(input: { lockableId: $id }) { unlockedRecord { locked } } }`,
            { id: found.id },
          )
          changed.push(input.lock ? "locked" : "unlocked")
        }
        return { number: resolved.number, url: found.url, changed }
      }),
  })

  return [discussions, discussion, discussionCreate, discussionUpdate]
}
