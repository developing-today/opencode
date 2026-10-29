import { describe, expect, test } from "bun:test"
import { ServerConnection } from "@/runtime/server/registry"
import { requireServerKey, rootSession, sessionHref } from "./session"

describe("session routes", () => {
  test("builds and decodes a server-keyed session route", () => {
    const server = ServerConnection.Key.make("https://example.com:4096")
    const href = sessionHref(server, "session-1")

    expect(href).toBe("/server/aHR0cHM6Ly9leGFtcGxlLmNvbTo0MDk2/session/session-1")
    expect(requireServerKey(href.split("/")[2])).toBe(server)
  })

  test("rejects malformed server keys", () => {
    expect(() => requireServerKey("not-base64")).toThrow("Invalid server route")
  })

  test("resolves the root session", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "root" },
      root: { id: "root" },
    }

    expect(
      await rootSession(sessions.child, async (id) => {
        const session = sessions[id]

        if (!session) throw new Error(`Missing session: ${id}`)

        return session
      }),
    ).toBe(sessions.root)
  })

  test("resolves the root session across a fork link", async () => {
    const sessions: Record<string, { id: string; parentID?: string; fork?: { sessionID: string } }> = {
      grandchild: { id: "grandchild", parentID: "fork" },
      fork: { id: "fork", fork: { sessionID: "child" } },
      child: { id: "child", parentID: "root" },
      root: { id: "root" },
    }
    const get = async (id: string) => {
      const session = sessions[id]

      if (!session) throw new Error(`Missing session: ${id}`)

      return session
    }

    expect(await rootSession(sessions.grandchild, get)).toBe(sessions.root)
    expect(await rootSession(sessions.fork, get)).toBe(sessions.root)
    expect(await rootSession(sessions.child, get)).toBe(sessions.root)
  })

  test("rejects a fork-link cycle", async () => {
    const sessions: Record<string, { id: string; parentID?: string; fork?: { sessionID: string } }> = {
      fork: { id: "fork", fork: { sessionID: "child" } },
      child: { id: "child", parentID: "fork" },
    }

    await expect(rootSession(sessions.fork, async (id) => sessions[id]!)).rejects.toThrow(
      "Session parent cycle: fork",
    )
  })

  test("rejects a parent cycle", async () => {
    const sessions: Record<string, { id: string; parentID?: string }> = {
      child: { id: "child", parentID: "parent" },
      parent: { id: "parent", parentID: "child" },
    }

    await expect(rootSession(sessions.child, async (id) => sessions[id]!)).rejects.toThrow(
      "Session parent cycle: child",
    )
  })
})
