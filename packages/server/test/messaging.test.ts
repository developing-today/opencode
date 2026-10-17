import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { OpenCode } from "@opencode/client"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("messaging routes send, read, hide and describe messages between sessions", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-messaging-")))
    const directory = path.join(tmp.path, "project")
    yield* Effect.promise(() => fs.mkdir(directory))
    const server = yield* startServer(path.join(tmp.path, "config"))
    const api = OpenCode.make({ baseUrl: server.base, headers: server.headers })
    yield* Effect.promise(async () => {
      const parent = await api.session.create({ location: { directory }, title: "parent" })
      const child = await api.session.create({ location: { directory }, parentID: parent.id, title: "child" })

      const sent = await api.messaging.send({ as: child.id, to: parent.id, text: "hello parent", deliver: "none" })
      expect(sent).toMatchObject({ seq: 1, created: true })

      const read = await api.messaging.query({ as: parent.id, topics: [sent.topic] })
      expect(read.messages).toEqual([
        expect.objectContaining({ topic: sent.topic, seq: 1, writer: child.id, data: "hello parent" }),
      ])

      expect(await api.messaging.inspect({ as: parent.id, topic: sent.topic, seq: 1 })).toMatchObject({
        writer: child.id,
        data: "hello parent",
      })

      const hidden = await api.messaging.visibility({ as: parent.id, topic: sent.topic, action: "hide", seqs: [1] })
      expect(hidden.targets).toEqual([1])
      expect((await api.messaging.query({ as: parent.id, topics: [sent.topic] })).messages).toEqual([])
      expect(
        (await api.messaging.query({ as: parent.id, topics: [sent.topic], kinds: ["message"], hidden: "include" }))
          .messages,
      ).toEqual([expect.objectContaining({ seq: 1, hidden: true })])

      const topics = await api.messaging.topics({ as: child.id })
      expect(topics.topics.map((topic) => topic.name)).toContain(sent.topic)

      const chain = await api.messaging.chain({ session: child.id, depth: "all" })
      expect(chain.chain.map((node) => node.id)).toEqual([child.id, parent.id])
      expect(chain.root).toBe(parent.id)

      const sessions = await api.messaging.sessions({ ancestor: parent.id })
      expect(sessions.sessions.map((node) => node.id)).toContain(child.id)

      const vars = await api.messaging.vars({ as: child.id, values: true })
      expect(vars.vars.length).toBeGreaterThan(0)

      const model = await api.messaging.model.status()
      expect(typeof model.state).toBe("string")
      expect(model.tiers?.map((tier) => tier.name)).toEqual(["tiny", "default", "step-up", "top"])

      await expect(api.messaging.inspect({ as: parent.id, topic: sent.topic, seq: 99 })).rejects.toMatchObject({
        _tag: "MessagingNotFoundError",
      })
      await expect(api.messaging.send({ as: child.id, text: "nowhere" })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
    })
  }),
)
