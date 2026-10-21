import { describe, expect, test } from "bun:test"
import { sessionFamily } from "../../src/util/session"

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("keeps filtered-out ancestors of matches and draws connectors for the filtered tree", () => {
    const sessions = [
      { id: "root" },
      { id: "idle-a", parentID: "root" },
      { id: "running-a1", parentID: "idle-a" },
      { id: "idle-a1x", parentID: "running-a1" },
      { id: "idle-a2", parentID: "idle-a" },
      { id: "idle-b", parentID: "root" },
      { id: "idle-b1", parentID: "idle-b" },
      { id: "idle-b1x", parentID: "idle-b1" },
      { id: "running-b1x1", parentID: "idle-b1x" },
      { id: "running-c", parentID: "root" },
    ]

    expect(sessionFamily(sessions, "root", (session) => session.id.startsWith("running"))).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
      { session: sessions[7], prefix: "   └─ " },
      { session: sessions[8], prefix: "      └─ " },
      { session: sessions[9], prefix: "" },
    ])
    expect(sessionFamily(sessions, "root", (session) => session.id === "missing")).toEqual([])
  })

  test("ends at a parent cycle", () => {
    const sessions = [
      { id: "x", parentID: "y" },
      { id: "y", parentID: "x" },
      { id: "z", parentID: "y" },
    ]

    expect(sessionFamily(sessions, "z")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "└─ " },
    ])
  })
})
