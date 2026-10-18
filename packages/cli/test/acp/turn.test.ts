import { describe, expect, test } from "bun:test"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { ACPElicitation } from "../../src/acp/elicitation"
import {
  childCreated,
  delivered,
  durableEvent,
  ephemeralEvent,
  makeSession,
  permissionAsked,
  startSession,
  startWire,
  succeeded,
  textDelta,
  toolCalled,
  toolStarted,
  toolSucceeded,
  turn,
} from "./wire-fixture"

const grandchild = {
  "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2, title: "Deeper" },
}

describe("acp turn events over the wire", () => {
  test.each([
    {
      childSessionUpdates: false,
      parent: [
        {
          sessionUpdate: "tool_call",
          toolCallId: "ses_grandchild:call_read",
          title: "Deeper: read",
          _meta: grandchild,
        },
        { sessionUpdate: "tool_call_update", toolCallId: "ses_grandchild:call_read", status: "in_progress" },
        { sessionUpdate: "tool_call_update", toolCallId: "ses_grandchild:call_read", status: "completed" },
      ],
      child: [],
    },
    {
      childSessionUpdates: true,
      parent: [],
      child: [
        { childSessionId: "ses_child", depth: 1, type: "status", status: "created" },
        { childSessionId: "ses_child", type: "status", status: "running" },
        {
          childSessionId: "ses_grandchild",
          parentSessionId: "ses_child",
          depth: 2,
          title: "Deeper",
          status: "created",
        },
        {
          childSessionId: "ses_grandchild",
          update: { sessionUpdate: "tool_call", toolCallId: "ses_grandchild:call_read" },
        },
        { childSessionId: "ses_grandchild", update: { sessionUpdate: "tool_call_update", status: "in_progress" } },
        { childSessionId: "ses_grandchild", update: { sessionUpdate: "tool_call_update", status: "completed" } },
        { childSessionId: "ses_grandchild", type: "status", status: "completed" },
        { childSessionId: "ses_background", type: "status", status: "created" },
        { childSessionId: "ses_child", type: "status", status: "completed" },
        { childSessionId: "ses_background", type: "status", status: "running" },
        { childSessionId: "ses_background", type: "update", update: { sessionUpdate: "agent_message_chunk" } },
        { childSessionId: "ses_background", type: "status", status: "completed" },
      ],
    },
  ])(
    "shows nested and background child work and keeps routing its permissions after the prompt (child capability: $childSessionUpdates)",
    async (row) => {
      await using acp = await startSession({
        capabilities: { childSessionUpdates: row.childSessionUpdates },
        onPrompt: ({ sessionID, id }) =>
          acp.server.prompts.length > 1
            ? turn(sessionID, id)
            : turn(
                sessionID,
                id,
                childCreated("ses_child", sessionID, "Explore code"),
                durableEvent("session.execution.started", { sessionID: "ses_child" }),
                childCreated("ses_grandchild", "ses_child", "Deeper"),
                toolStarted("ses_grandchild", "call_read", "read"),
                toolCalled("ses_grandchild", "call_read", { path: "/workspace/src/index.ts" }),
                permissionAsked("ses_grandchild", "perm_child", {
                  action: "read",
                  source: { type: "tool", messageID: "msg_child", id: "call_read" },
                }),
                toolSucceeded("ses_grandchild", "call_read", {}, "source"),
                succeeded("ses_grandchild"),
                childCreated("ses_background", sessionID, "Research"),
                succeeded("ses_child"),
              ),
        permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      })

      expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
      const responded = turnUpdates(acp.updates).length
      acp.server.send(
        durableEvent("session.execution.started", { sessionID: "ses_background" }),
        permissionAsked("ses_background", "perm_background", {
          action: "read",
          metadata: { path: "/workspace/notes.md" },
        }),
        textDelta("ses_background", "msg_background", "late"),
        succeeded("ses_background"),
        // Woken again later, the child still asks the client.
        permissionAsked("ses_background", "perm_after_end", { action: "read" }),
      )
      await acp.until(() => acp.server.replies.length === 3, "child permission replies")
      expect(turnUpdates(acp.updates).slice(responded)).toEqual([])
      expect((await acp.prompt(acp.sessionId, "again")).stopReason).toBe("end_turn")

      expect(turnUpdates(acp.updates).map((item) => item.update)).toMatchObject(row.parent)
      expect(acp.childUpdates).toMatchObject(row.child)
      expect(acp.permissions).toMatchObject([
        {
          sessionId: acp.sessionId,
          toolCall: {
            toolCallId: "ses_grandchild:call_read",
            title: "Deeper: /workspace/src/index.ts",
            _meta: grandchild,
          },
        },
        {
          sessionId: acp.sessionId,
          toolCall: {
            toolCallId: "ses_background:perm_background",
            title: "Research: /workspace/notes.md",
            _meta: {
              "opencode/child-session": { id: "ses_background", parentID: acp.sessionId, depth: 1, title: "Research" },
            },
          },
        },
        {
          sessionId: acp.sessionId,
          toolCall: { toolCallId: "ses_background:perm_after_end", title: "Research" },
        },
      ])
      expect(acp.server.replies).toEqual([
        { sessionID: "ses_grandchild", requestID: "perm_child", decision: "once" },
        { sessionID: "ses_background", requestID: "perm_background", decision: "once" },
        { sessionID: "ses_background", requestID: "perm_after_end", decision: "once" },
      ])
    },
  )

  test("follows a child continued in a later prompt and the subagents it launches", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) =>
        acp.server.prompts.length > 1
          ? turn(
              sessionID,
              id,
              // No `session.created` this time: the child exists from the first prompt.
              durableEvent("session.execution.started", { sessionID: "ses_child" }),
              childCreated("ses_grandchild", "ses_child", "Deeper"),
              toolStarted("ses_grandchild", "call_read", "read"),
              permissionAsked("ses_grandchild", "perm_deep", {
                action: "read",
                metadata: { path: "/workspace/deep.md" },
              }),
              permissionAsked("ses_child", "perm_child", { action: "read", metadata: { path: "/workspace/child.md" } }),
              succeeded("ses_grandchild"),
              succeeded("ses_child"),
            )
          : turn(sessionID, id, childCreated("ses_child", sessionID, "Explore code"), succeeded("ses_child")),
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
    })
    acp.server.sessions.set("ses_child", {
      ...makeSession("ses_child"),
      parentID: acp.sessionId,
      title: "Explore code",
    })

    expect((await acp.prompt(acp.sessionId, "start")).stopReason).toBe("end_turn")
    expect((await acp.prompt(acp.sessionId, "continue")).stopReason).toBe("end_turn")

    expect(turnUpdates(acp.updates).map((item) => item.update)).toContainEqual(
      expect.objectContaining({ sessionUpdate: "tool_call", toolCallId: "ses_grandchild:call_read" }),
    )
    expect(acp.permissions).toMatchObject([
      {
        toolCall: {
          toolCallId: "ses_grandchild:perm_deep",
          title: "Deeper: /workspace/deep.md",
          _meta: { "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2 } },
        },
      },
      {
        toolCall: {
          toolCallId: "ses_child:perm_child",
          title: "Explore code: /workspace/child.md",
          _meta: {
            "opencode/child-session": { id: "ses_child", parentID: acp.sessionId, depth: 1, title: "Explore code" },
          },
        },
      },
    ])
    expect(acp.server.replies).toEqual([
      { sessionID: "ses_grandchild", requestID: "perm_deep", decision: "once" },
      { sessionID: "ses_child", requestID: "perm_child", decision: "once" },
    ])
  })

  test("asks the session's own permission when a background result wakes it after the prompt", async () => {
    await using acp = await startSession({ permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    acp.server.send(
      durableEvent("session.execution.started", { sessionID: acp.sessionId }),
      permissionAsked(acp.sessionId, "perm_woken", { action: "read", metadata: { path: "/workspace/later.md" } }),
    )
    await acp.until(() => acp.server.replies.length === 1, "the woken session's permission reply")

    expect(acp.permissions).toMatchObject([
      { sessionId: acp.sessionId, toolCall: { toolCallId: "perm_woken", title: "/workspace/later.md" } },
    ])
    expect(acp.server.replies).toEqual([{ sessionID: acp.sessionId, requestID: "perm_woken", decision: "once" }])
  })

  test("asks pending permissions and questions from the tree when a prompt starts, and none from other trees", async () => {
    await using acp = await startSession({
      capabilities: { elicitation: true },
      permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }),
      elicitation: () => ({ action: "accept", content: { pm: "bun" } }),
    })
    acp.server.sessions.set("ses_child", {
      ...makeSession("ses_child"),
      parentID: acp.sessionId,
      title: "Explore code",
    })
    acp.server.sessions.set("ses_grandchild", {
      ...makeSession("ses_grandchild"),
      parentID: "ses_child",
      title: "Deeper",
    })
    acp.server.sessions.set("ses_other", makeSession("ses_other"))
    acp.server.pending.permissions.push(
      {
        id: "perm_deep",
        sessionID: "ses_grandchild",
        action: "read",
        resources: ["*"],
        metadata: { path: "/workspace/deep.md" },
      },
      { id: "perm_other", sessionID: "ses_other", action: "read", resources: ["*"] },
    )
    acp.server.pending.forms.push({
      id: "frm_pending",
      sessionID: "ses_child",
      title: "Which package manager?",
      metadata: { kind: "question" },
      fields: [{ key: "pm", title: "Package manager", type: "string", options: [{ value: "bun", label: "Bun" }] }],
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")

    expect(acp.permissions).toMatchObject([
      {
        toolCall: {
          toolCallId: "ses_grandchild:perm_deep",
          title: "Deeper: /workspace/deep.md",
          _meta: {
            "opencode/child-session": { id: "ses_grandchild", parentID: "ses_child", depth: 2, title: "Deeper" },
          },
        },
      },
    ])
    expect(acp.elicitations).toMatchObject([
      { sessionId: acp.sessionId, message: "Explore code: Which package manager?" },
    ])
    // Its tool call was never sent, so the question names none.
    expect(acp.elicitations[0]).not.toHaveProperty("toolCallId")
    expect(acp.server.replies).toEqual([{ sessionID: "ses_grandchild", requestID: "perm_deep", decision: "once" }])
    expect(acp.server.repliedForms).toEqual([{ sessionID: "ses_child", formID: "frm_pending", answer: { pm: "bun" } }])
  })

  test("asks a loaded session's pending asks once its response is out", async () => {
    await using acp = await startWire({ permission: () => ({ outcome: { outcome: "selected", optionId: "once" } }) })
    await acp.initialize()
    acp.server.sessions.set("ses_loaded", makeSession("ses_loaded"))
    acp.server.sessions.set("ses_child", { ...makeSession("ses_child"), parentID: "ses_loaded", title: "Explore code" })
    acp.server.pending.permissions.push({
      id: "perm_waiting",
      sessionID: "ses_child",
      action: "read",
      resources: ["*"],
      metadata: { path: "/workspace/waiting.md" },
    })

    await acp.request("session/load", { sessionId: "ses_loaded", cwd: "/workspace", mcpServers: [] })
    await acp.until(() => acp.server.replies.length === 1, "the pending permission reply")

    expect(acp.permissions).toMatchObject([
      {
        sessionId: "ses_loaded",
        toolCall: { toolCallId: "ses_child:perm_waiting", title: "Explore code: /workspace/waiting.md" },
      },
    ])
  })

  test("cancels unsupported session forms so execution can continue", async () => {
    await using acp = await startSession({
      onPrompt: ({ sessionID, id }) => [
        delivered(sessionID, id),
        ephemeralEvent("form.created", {
          form: {
            id: "frm_question",
            sessionID,
            title: "Questions",
            metadata: { kind: "question" },
            fields: [{ key: "q0", title: "Choice", type: "string" }],
          },
        }),
      ],
      onFormCancel: ({ sessionID, formID }) => [
        ephemeralEvent("form.cancelled", { sessionID, id: formID }),
        succeeded(sessionID),
      ],
    })

    expect((await acp.prompt(acp.sessionId, "hello")).stopReason).toBe("end_turn")
    expect(acp.server.cancelledForms).toEqual([
      { sessionID: acp.sessionId, formID: "frm_question", message: ACPElicitation.UnshownQuestionMessage },
    ])
    expect(acp.elicitations).toEqual([])
  })
})

function turnUpdates(updates: readonly SessionNotification[]) {
  return updates.filter(
    (item) => item.update.sessionUpdate !== "available_commands_update" && item.update.sessionUpdate !== "usage_update",
  )
}
