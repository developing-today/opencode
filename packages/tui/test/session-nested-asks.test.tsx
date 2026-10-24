import { expect, test } from "bun:test"
import type { FormInfo, PermissionRequest, SessionInfo } from "@opencode/client"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const root = session("ses_nested_root", "Nested root")
const child = session("ses_nested_child", "Nested child", root.id, 3)
const sibling = session("ses_nested_sibling", "Nested sibling", root.id, 2)
const grandchild = session("ses_nested_grandchild", "Nested grandchild", child.id)

test("the root view prompts for and answers asks a nested subagent left pending before startup", async () => {
  await using state = await tmpdir()
  const permission = {
    id: "per_nested",
    sessionID: grandchild.id,
    action: "shell",
    resources: ["echo nested-permission"],
  } satisfies PermissionRequest
  const form = {
    id: "frm_nested",
    sessionID: grandchild.id,
    title: "Nested form fixture",
    fields: [{ key: "target", type: "string", title: "Target", options: [{ value: "staging", label: "Staging" }] }],
  } satisfies FormInfo
  await using setup = await createNestedFixture(state.path, { viewed: root.id, permission, form })
  await setup.ready
  const frame = () => setup.captureCharFrame()

  // The grandchild is two levels below the viewed root, so its asks appear only once the whole tree is discovered.
  await until(() => frame().includes(`From ${grandchild.title}`) && frame().includes("echo nested-permission"), frame)
  setup.mockInput.pressEnter()
  await until(() => setup.replies.permission.length === 1, frame)
  expect(setup.replies.permission).toEqual([{ decision: "once" }])

  await until(() => frame().includes(form.title) && !frame().includes(`From ${grandchild.title}`), frame)
  setup.mockInput.pressEnter()
  await until(() => setup.replies.form.length === 1, frame)
  await until(() => !frame().includes(form.title), frame)
})

test("a subagent view opened before its ancestors lists the whole family", async () => {
  await using state = await tmpdir()
  await using setup = await createNestedFixture(state.path, {
    viewed: grandchild.id,
    running: [child.id, sibling.id, grandchild.id],
  })
  await setup.ready
  const frame = () => setup.captureCharFrame()
  const row = (text: string) =>
    frame()
      .split("\n")
      .findIndex((line) => line.includes(text))

  // A subagent view opens its picker, which needs the root's tree rather than the viewed session's.
  await until(() => row("Build: Nested sibling") > -1, frame)
  expect(row("└─ Build: Nested grandchild")).toBe(row("Build: Nested child") + 1)
  expect(row("Build: Nested sibling")).toBe(row("Build: Nested child") + 2)
})

async function createNestedFixture(
  state: string,
  input: { viewed: string; running?: string[]; permission?: PermissionRequest; form?: FormInfo },
) {
  const sessions = [root, child, sibling, grandchild]
  const location = { directory, project: { id: root.projectID, directory, canonical: directory } }
  const replies = { permission: [] as unknown[], form: [] as unknown[] }
  const setup = await createAppFixture({
    width: 120,
    height: 36,
    state,
    args: { sessionID: input.viewed },
    config: { animations: false, tabs: { mode: "off" }, session: { sidebar: "hide" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session/active")
        return json({ data: Object.fromEntries((input.running ?? []).map((id) => [id, { type: "running" }])) })
      if (url.pathname === "/api/session") {
        const parentID = url.searchParams.get("parentID")
        return json({ data: sessions.filter((item) => parentID && item.parentID === parentID), cursor: {} })
      }
      const match = url.pathname.match(/^\/api\/session\/([^/]+)(?:\/(.+))?$/)
      const target = sessions.find((item) => item.id === match?.[1])
      if (!match || !target) return undefined
      if (match[2] === undefined) return json({ data: target })
      if (match[2] === "message") return json({ data: [], cursor: {} })
      if (match[2] === "inbox") return json({ data: [] })
      if (match[2] === "permission") {
        const pending = input.permission?.sessionID === target.id && replies.permission.length === 0
        return json({ data: pending ? [input.permission] : [] })
      }
      if (match[2] === "form") {
        const pending = input.form?.sessionID === target.id && replies.form.length === 0
        return json({ data: pending ? [input.form] : [] })
      }
      if (match[2] === `permission/${input.permission?.id}/reply`) {
        replies.permission.push(await request.json())
        return new Response(null, { status: 204 })
      }
      if (match[2] === `form/${input.form?.id}/reply`) {
        replies.form.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  return { ...setup, replies }
}

function session(id: string, title: string, parentID?: string, updated = 1): SessionInfo {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    title,
    projectID: "proj_nested",
    location: { directory },
    agent: "build",
    model: { providerID: "fixture", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated },
  }
}

// Polls on the wall clock: discovery and replies are requests, not frames.
async function until(check: () => boolean, frame: () => string) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for condition\n${frame()}`)
    await Bun.sleep(10)
  }
}
