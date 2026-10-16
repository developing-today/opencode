import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { GitHubDiscussions } from "@opencode/core/tool/plugin/github/discussion"
import { withEnv } from "../fixture/env"
import { testEffect } from "../lib/effect"
import { fakeGitHub, find, makeDeps, run, type Request } from "./fixture"

const it = testEffect(LayerNode.compile(AppProcess.node))

const env = { GH_TOKEN: "test-token", GITHUB_TOKEN: undefined }

type Body = { query: string; variables: Record<string, unknown> }
const graphql = (requests: ReadonlyArray<Request>) =>
  requests.filter((request) => request.path === "/graphql").map((request) => request.body as Body)

const categories = {
  nodes: [
    { id: "DIC_general", name: "General", slug: "general", isAnswerable: false },
    { id: "DIC_qa", name: "Q&A", slug: "q-a", isAnswerable: true },
  ],
}

const author = (login: string) => ({ login, __typename: "User" })

describe("github discussions", () => {
  it.live("discussions resolves a category by slug and lists with its id", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL { id discussionCategories": {
            body: { repository: { id: "R_1", discussionCategories: categories } },
          },
          "GRAPHQL discussions(first: $first": {
            body: {
              repository: {
                discussions: {
                  totalCount: 1,
                  nodes: [
                    {
                      number: 5,
                      title: "How do I configure X?",
                      url: "https://github.com/acme/widgets/discussions/5",
                      isAnswered: true,
                      closed: false,
                      updatedAt: "2026-02-01T00:00:00Z",
                      category: { name: "Q&A" },
                      author: author("carol"),
                      comments: { totalCount: 4 },
                    },
                  ],
                },
              },
            },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run(find(GitHubDiscussions.tools(deps), "discussions"), {
          repo: "acme/widgets",
          category: "q-a",
          answered: true,
        })
        expect(graphql(github.requests)[1]?.variables).toEqual({
          owner: "acme",
          name: "widgets",
          first: 20,
          categoryId: "DIC_qa",
          answered: true,
        })
        expect(result).toEqual({
          total: 1,
          items: [
            {
              number: 5,
              title: "How do I configure X?",
              url: "https://github.com/acme/widgets/discussions/5",
              category: "Q&A",
              author: { login: "carol", kind: "human" },
              answered: true,
              closed: false,
              comments: 4,
              updated_at: "2026-02-01T00:00:00Z",
            },
          ],
          categories: [
            { name: "General", slug: "general", answerable: false },
            { name: "Q&A", slug: "q-a", answerable: true },
          ],
        })
      }),
    ),
  )

  it.live("discussions with a query searches with the category name", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL { id discussionCategories": {
            body: { repository: { id: "R_1", discussionCategories: categories } },
          },
          "GRAPHQL search(type: DISCUSSION": { body: { search: { discussionCount: 0, nodes: [] } } },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        yield* run(find(GitHubDiscussions.tools(deps), "discussions"), {
          repo: "acme/widgets",
          category: "general",
          answered: false,
          query: "timeout",
        })
        expect(graphql(github.requests)[1]?.variables).toEqual({
          query: "repo:acme/widgets category:General is:unanswered timeout",
          first: 20,
        })
      }),
    ),
  )

  it.live("discussion_create resolves a category by name and an unknown one lists the available categories", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL { id discussionCategories": {
            body: { repository: { id: "R_1", discussionCategories: categories } },
          },
          "GRAPHQL createDiscussion": {
            body: {
              createDiscussion: { discussion: { number: 9, url: "https://github.com/acme/widgets/discussions/9" } },
            },
          },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const tool = find(GitHubDiscussions.tools(deps), "discussion_create")
        const created = yield* run(tool, { repo: "acme/widgets", title: "Idea", body: "Details", category: "q&a" })
        expect(created).toEqual({ number: 9, url: "https://github.com/acme/widgets/discussions/9" })
        expect(graphql(github.requests)[1]?.variables).toEqual({
          repositoryId: "R_1",
          categoryId: "DIC_qa",
          title: "Idea",
          body: "Details",
        })
        expect(asserted.map((item) => item.action)).toEqual(["github_discussion_create"])

        const missing = yield* run(tool, {
          repo: "acme/widgets",
          title: "Idea",
          body: "Details",
          category: "Ideas",
        }).pipe(Effect.flip)
        expect(missing.message).toBe(
          'github.discussion_create: No discussion category "Ideas". Available: General (general), Q&A (q-a).',
        )
        expect(graphql(github.requests).filter((body) => body.query.includes("createDiscussion"))).toHaveLength(1)
        expect(asserted).toHaveLength(1)
      }),
    ),
  )

  it.live("discussion nests replies under comments and flags the answer", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const comment = (id: string, login: string, body: string) => ({
          id,
          body,
          createdAt: "2026-02-02T00:00:00Z",
          url: `https://github.com/acme/widgets/discussions/5#${id}`,
          isMinimized: false,
          author: author(login),
        })
        const github = fakeGitHub({
          "GRAPHQL answer { id author": {
            body: {
              repository: {
                discussion: {
                  id: "D_5",
                  number: 5,
                  title: "How do I configure X?",
                  body: "Question body",
                  url: "https://github.com/acme/widgets/discussions/5",
                  closed: false,
                  stateReason: null,
                  locked: false,
                  createdAt: "2026-02-01T00:00:00Z",
                  updatedAt: "2026-02-03T00:00:00Z",
                  author: author("carol"),
                  category: { name: "Q&A", slug: "q-a", isAnswerable: true },
                  answer: { id: "DC_2", author: author("dave") },
                  comments: {
                    totalCount: 2,
                    nodes: [
                      { ...comment("DC_1", "erin", "Me too"), isAnswer: false, replies: { totalCount: 0, nodes: [] } },
                      {
                        ...comment("DC_2", "dave", "Set X=1"),
                        isAnswer: true,
                        replies: {
                          totalCount: 1,
                          nodes: [{ ...comment("DC_3", "carol", "Thanks"), isMinimized: true }],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        })
        const { deps } = yield* makeDeps({ http: github.http })
        const result = yield* run<object, Record<string, unknown>>(find(GitHubDiscussions.tools(deps), "discussion"), {
          repo: "acme/widgets",
          discussion: "https://github.com/acme/widgets/discussions/5",
        })
        expect(graphql(github.requests)[0]?.variables).toEqual({
          owner: "acme",
          name: "widgets",
          number: 5,
          commentLimit: 50,
        })
        expect(result.answer).toEqual({ id: "DC_2", author: { login: "dave", kind: "human" } })
        expect(result.category).toEqual({ name: "Q&A", slug: "q-a", answerable: true })
        expect(result.comments).toEqual([
          {
            id: "DC_1",
            author: { login: "erin", kind: "human" },
            body: "Me too",
            created_at: "2026-02-02T00:00:00Z",
            url: "https://github.com/acme/widgets/discussions/5#DC_1",
            is_answer: false,
            replies_total: 0,
            replies: [],
          },
          {
            id: "DC_2",
            author: { login: "dave", kind: "human" },
            body: "Set X=1",
            created_at: "2026-02-02T00:00:00Z",
            url: "https://github.com/acme/widgets/discussions/5#DC_2",
            is_answer: true,
            replies_total: 1,
            replies: [
              {
                id: "DC_3",
                author: { login: "carol", kind: "human" },
                body: "Thanks",
                created_at: "2026-02-02T00:00:00Z",
                url: "https://github.com/acme/widgets/discussions/5#DC_3",
                hidden: true,
              },
            ],
          },
        ])
      }),
    ),
  )

  it.live("discussion_update marks an answer and closes with the uppercase reason", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL discussion(number: $number) { id url }": {
            body: {
              repository: {
                discussion: { id: "D_5", url: "https://github.com/acme/widgets/discussions/5" },
                discussionCategories: categories,
              },
            },
          },
          "GRAPHQL { markDiscussionCommentAsAnswer(": {
            body: { markDiscussionCommentAsAnswer: { discussion: { id: "D_5" } } },
          },
          "GRAPHQL closeDiscussion(": { body: { closeDiscussion: { discussion: { closed: true } } } },
          "GRAPHQL ... on DiscussionComment { discussion { id } }": { body: { node: { discussion: { id: "D_5" } } } },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const result = yield* run(find(GitHubDiscussions.tools(deps), "discussion_update"), {
          repo: "acme/widgets",
          discussion: 5,
          answer: "DC_2",
          close: "resolved",
        })
        expect(result).toEqual({
          number: 5,
          url: "https://github.com/acme/widgets/discussions/5",
          changed: ["answer: DC_2", "closed: resolved"],
        })
        const calls = graphql(github.requests)
        expect(calls.slice(1).map((body) => body.variables)).toEqual([
          { id: "DC_2" },
          { id: "DC_2" },
          { discussionId: "D_5", reason: "RESOLVED" },
        ])
        expect(calls[2]?.query).toContain("{ markDiscussionCommentAsAnswer(input: { id: $id })")
        expect(calls[3]?.query).toContain("closeDiscussion(input: { discussionId: $discussionId, reason: $reason })")
        expect(asserted.map((item) => item.action)).toEqual(["github_discussion_update"])
      }),
    ),
  )

  it.live("discussion_update refuses an answer comment from another discussion before changing anything", () =>
    withEnv(env, () =>
      Effect.gen(function* () {
        const github = fakeGitHub({
          "GRAPHQL discussion(number: $number) { id url }": {
            body: {
              repository: {
                discussion: { id: "D_5", url: "https://github.com/acme/widgets/discussions/5" },
                discussionCategories: categories,
              },
            },
          },
          "GRAPHQL ... on DiscussionComment { discussion { id } }": {
            body: { node: { discussion: { id: "D_OTHER" } } },
          },
        })
        const { deps, asserted } = yield* makeDeps({ http: github.http })
        const failure = yield* run(find(GitHubDiscussions.tools(deps), "discussion_update"), {
          repo: "acme/widgets",
          discussion: 5,
          answer: "DC_9",
        }).pipe(Effect.flip)
        expect(String((failure as { message?: string }).message)).toContain(
          "DC_9 is not a comment on acme/widgets discussion #5",
        )
        expect(asserted).toEqual([])
        expect(
          graphql(github.requests).some((body) => String(body.query).includes("markDiscussionCommentAsAnswer")),
        ).toBe(false)
      }),
    ),
  )
})
