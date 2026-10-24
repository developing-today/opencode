import { expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client"
import { createData } from "@opencode/client/solid"
import { createRoot, createSignal } from "solid-js"
import { createFamilyDiscovery } from "../../../src/routes/session/family"
import { createApi, createFetch, directory, json } from "../../fixture/tui-client"

const sessions: Record<string, SessionInfo> = {
  root: info("root"),
  child: info("child", "root"),
  sibling: info("sibling", "root"),
  grandchild: info("grandchild", "child"),
}

// A subagent view of the grandchild, opened before its ancestors. Retries run when the test runs them.
function setup(failures: number) {
  const reads = { child: 0 }
  const retries: { delay: number; run: () => void }[] = []
  const api = createApi(
    createFetch((url) => {
      if (url.pathname === "/api/session") {
        const parentID = url.searchParams.get("parentID")
        return json({ data: Object.values(sessions).filter((session) => session.parentID === parentID), cursor: {} })
      }
      const sessionID = url.pathname.match(/^\/api\/session\/([^/]+)$/)?.[1] ?? ""
      if (sessionID === "child" && reads.child++ < failures)
        return json({ _tag: "UnknownError", message: "Session store unavailable" }, { status: 503 })
      const session = sessions[sessionID]
      if (session) return json({ data: session })
    }).fetch,
  )
  return createRoot((dispose) => {
    const data = createData({ api: () => api, event: { on: () => () => {}, listen: () => () => {} }, directory })
    const [connected, setConnected] = createSignal(true)
    createFamilyDiscovery({
      session: data.session,
      sessionID: () => "grandchild",
      connected,
      schedule: (run, delay) => {
        retries.push({ delay, run })
        return () => {}
      },
    })
    return { data, reads, retries, setConnected, dispose }
  })
}

test("retries a failed ancestor read, then loads the root's whole tree", async () => {
  const scope = setup(1)
  try {
    await scope.data.session.sync("grandchild")
    await wait(() => scope.retries.length === 1)
    expect(scope.retries[0]?.delay).toBe(250)
    expect(scope.data.session.get("sibling")).toBeUndefined()

    scope.retries[0]?.run()
    await wait(() => scope.data.session.get("sibling") !== undefined)
    expect(scope.data.session.family("grandchild").toSorted()).toEqual(["child", "grandchild", "root", "sibling"])
    expect(scope.retries).toHaveLength(1)
  } finally {
    scope.dispose()
  }
})

test("bounds the retries and starts over after a reconnect", async () => {
  const scope = setup(Infinity)
  try {
    await scope.data.session.sync("grandchild")
    for (const count of [1, 2, 3, 4, 5]) {
      await wait(() => scope.retries.length === count)
      scope.retries[count - 1]?.run()
    }
    // Join the fifth retry's read: it fails like the others and schedules nothing further.
    await scope.data.session.sync("child").catch(() => undefined)
    expect(scope.reads.child).toBe(6)
    expect(scope.retries).toHaveLength(5)

    scope.setConnected(false)
    scope.setConnected(true)
    await wait(() => scope.retries.length === 6)
    expect(scope.reads.child).toBe(7)
    expect(scope.retries.map((retry) => retry.delay)).toEqual([250, 500, 1_000, 2_000, 4_000, 250])
  } finally {
    scope.dispose()
  }
})

function info(id: string, parentID?: string): SessionInfo {
  return {
    id,
    ...(parentID ? { parentID } : {}),
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
}

// Requests resolve on their own; this only waits for them, never for a retry delay.
async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
