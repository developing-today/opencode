import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ModelPlan } from "@opencode/core/model-plan"

const NOW = "2026-10-14T09:00:00.000Z"
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "model-plan-"))

describe("ModelPlan store", () => {
  test("a missing store reads as empty, and a write leaves no temporary file behind", () => {
    const root = dir()
    expect(ModelPlan.readStore(root)).toEqual(ModelPlan.emptyStore())
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      {
        providerID: "anthropic",
        plan: "Max 20x",
        label: "Personal",
        quotas: [{ name: "5-hour", unit: "messages", windowHours: 5, resetRule: "rolling" }],
      },
      NOW,
    )
    ModelPlan.writeStore(store, root)
    expect(fs.readdirSync(root).filter((file) => file.endsWith(".tmp"))).toEqual([])
    expect(ModelPlan.readStore(root).plans).toHaveLength(1)
  })

  test("a write retries a transient rename failure and lands", () => {
    const root = dir()
    const rename = fs.renameSync
    let calls = 0
    const spy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      rename(source, destination)
    })
    try {
      ModelPlan.writeStore(ModelPlan.emptyStore(), root)
      expect(calls).toBe(2)
      expect(ModelPlan.readStore(root)).toEqual(ModelPlan.emptyStore())
      expect(fs.readdirSync(root).filter((file) => file.endsWith(".tmp"))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test("a write whose rename keeps failing transiently throws and leaves no temporary file", () => {
    const root = dir()
    let calls = 0
    const spy = spyOn(fs, "renameSync").mockImplementation(() => {
      calls += 1
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    })
    try {
      expect(() => ModelPlan.writeStore(ModelPlan.emptyStore(), root)).toThrow("operation not permitted")
      expect(calls).toBe(5)
      expect(fs.readdirSync(root)).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test("upsert creates a plan with an id from its provider and name, then updates that same record", () => {
    const first = ModelPlan.upsertPlan(ModelPlan.emptyStore(), { providerID: "anthropic", plan: "Max 20x" }, NOW)
    expect(first.plan.id).toBe("anthropic-max-20x")
    expect(first.plan).toMatchObject({ status: "active", coverage: "subscription", quotas: [], createdAt: NOW })
    const second = ModelPlan.upsertPlan(
      first.store,
      {
        id: "anthropic-max-20x",
        fee: { amount: 200, currency: "USD", period: "monthly" },
        verifiedAt: "2026-10-14",
      },
      "2026-10-15T00:00:00.000Z",
    )
    expect(second.store.plans).toHaveLength(1)
    expect(second.plan).toMatchObject({
      plan: "Max 20x",
      fee: { amount: 200, currency: "USD", period: "monthly" },
      verifiedAt: "2026-10-14",
      createdAt: NOW,
      updatedAt: "2026-10-15T00:00:00.000Z",
    })
  })

  test("a null clears a field and an omitted field is kept", () => {
    const { store } = ModelPlan.upsertPlan(
      ModelPlan.emptyStore(),
      { providerID: "openai", plan: "Plus", expiresOn: "2026-12-01" },
      NOW,
    )
    const next = ModelPlan.upsertPlan(store, { id: "openai-plus", expiresOn: null }, NOW)
    expect(next.plan.plan).toBe("Plus")
    expect(next.plan.expiresOn).toBeUndefined()
  })

  test("a plan needs a provider, and a malformed store is an error rather than an empty one", () => {
    expect(() => ModelPlan.upsertPlan(ModelPlan.emptyStore(), { label: "no provider" }, NOW)).toThrow("providerID")
    const root = dir()
    fs.writeFileSync(path.join(root, "plans.json"), "{ not json")
    expect(() => ModelPlan.readStore(root)).toThrow("not valid JSON")
    fs.writeFileSync(path.join(root, "plans.json"), JSON.stringify({ version: 2, plans: [] }))
    expect(() => ModelPlan.readStore(root)).toThrow()
  })

  test("a model needs a tier when it is first set; a pool takes a purpose and a tier", () => {
    expect(() => ModelPlan.setModel(ModelPlan.emptyStore(), "openai/gpt-6-astra", {}, NOW)).toThrow("needs a tier")
    const store = ModelPlan.setModel(
      ModelPlan.emptyStore(),
      "openai/gpt-6-astra",
      { tier: "frontier", coveredBy: ["openai-plus"] },
      NOW,
    )
    expect(store.models["openai/gpt-6-astra"]).toMatchObject({ tier: "frontier", coveredBy: ["openai-plus"] })
    const moved = ModelPlan.setModel(store, "openai/gpt-6-astra", { tier: "cheap" }, NOW)
    expect(moved.models["openai/gpt-6-astra"]).toMatchObject({ tier: "cheap", coveredBy: ["openai-plus"] })
    const pooled = ModelPlan.setPool(
      moved,
      "hard",
      { tier: "frontier", purpose: "debugging with an unknown cause" },
      NOW,
    )
    expect(pooled.pools.hard).toMatchObject({ tier: "frontier", purpose: "debugging with an unknown cause" })
  })

  test("slug never ends in a dash, including when the 64-char slice cuts after a separator", () => {
    expect(ModelPlan.slug("a".repeat(63) + " b c")).toBe("a".repeat(63))
    expect(ModelPlan.slug("a".repeat(64))).toBe("a".repeat(64))
    expect(ModelPlan.slug("Claude Max 20x")).toBe("claude-max-20x")
    expect(ModelPlan.slug("--weird--name--")).toBe("weird-name")
  })

  test("notes are appended, filtered and kept in order, and a damaged line is skipped and counted", () => {
    const root = dir()
    ModelPlan.addNote(
      { text: "ran out of claude too fast", kind: "experience", providerID: "anthropic" },
      "2026-10-10T10:00:00.000Z",
      root,
    )
    ModelPlan.addNote(
      { text: "I always have GPT left at month end", kind: "expectation", providerID: "openai" },
      "2026-10-11T10:00:00.000Z",
      root,
    )
    fs.appendFileSync(path.join(root, "plan-notes.jsonl"), "not a note\n")
    const all = ModelPlan.readNotes({}, root)
    expect(all.notes.map((note) => note.text)).toEqual([
      "ran out of claude too fast",
      "I always have GPT left at month end",
    ])
    expect(all.skipped).toBe(1)
    expect(ModelPlan.readNotes({ providerID: "anthropic" }, root).notes).toHaveLength(1)
    expect(ModelPlan.readNotes({ since: "2026-10-11T00:00:00.000Z" }, root).notes.map((note) => note.kind)).toEqual([
      "expectation",
    ])
    expect(ModelPlan.readNotes({ limit: 1 }, root).notes[0]?.kind).toBe("expectation")
    expect(ModelPlan.readNotes({ limit: 0 }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: -1 }, root).notes).toEqual([])
    expect(ModelPlan.readNotes({ limit: 0 }, root).skipped).toBe(1)
  })

  test("notes sort chronologically across timestamp formats and limits keep the newest", () => {
    const root = dir()
    ModelPlan.addNote({ text: "half second later" }, "2026-10-27T09:00:00.500Z", root)
    ModelPlan.addNote({ text: "same time without milliseconds" }, "2026-10-27T09:00:00Z", root)
    ModelPlan.addNote({ text: "offset, but earliest" }, "2026-10-27T10:30:00+02:00", root)

    expect(ModelPlan.readNotes({}, root).notes.map((note) => note.text)).toEqual([
      "offset, but earliest",
      "same time without milliseconds",
      "half second later",
    ])
    expect(ModelPlan.readNotes({ limit: 1 }, root).notes.map((note) => note.text)).toEqual(["half second later"])
    expect(ModelPlan.readNotes({ limit: 2 }, root).notes.map((note) => note.text)).toEqual([
      "same time without milliseconds",
      "half second later",
    ])
  })

  test("unparseable timestamps sort before parsed dates and equal instants stay stable", () => {
    const root = dir()
    ModelPlan.addNote({ text: "unparseable" }, "not-a-date", root)
    ModelPlan.addNote({ text: "equal instant first" }, "2026-10-27T09:00:00Z", root)
    ModelPlan.addNote({ text: "equal instant second" }, "2026-10-27T11:00:00+02:00", root)
    ModelPlan.addNote({ text: "later" }, "2026-10-27T09:00:01Z", root)

    expect(ModelPlan.readNotes({}, root).notes.map((note) => note.text)).toEqual([
      "unparseable",
      "equal instant first",
      "equal instant second",
      "later",
    ])
    expect(ModelPlan.readNotes({ limit: 1 }, root).notes.map((note) => note.text)).toEqual(["later"])
  })

  test("an unparseable since throws instead of silently returning no notes", () => {
    const root = dir()
    ModelPlan.addNote({ text: "a note" }, "2026-10-27T09:00:00Z", root)
    expect(() => ModelPlan.readNotes({ since: "not-a-date" }, root)).toThrow("not-a-date")
    expect(ModelPlan.readNotes({ since: "2026-12-01T00:00:00.000Z" }, root)).toEqual({ notes: [], skipped: 0 })
  })

  test("a note whose timestamp does not parse is counted skipped under a since filter", () => {
    const root = dir()
    ModelPlan.addNote({ text: "bad timestamp" }, "not-a-date", root)
    ModelPlan.addNote({ text: "good timestamp" }, "2026-10-27T09:00:00Z", root)
    const filtered = ModelPlan.readNotes({ since: "2026-01-01T00:00:00.000Z" }, root)
    expect(filtered.notes.map((note) => note.text)).toEqual(["good timestamp"])
    expect(filtered.skipped).toBe(1)
    const unfiltered = ModelPlan.readNotes({}, root)
    expect(unfiltered.notes.map((note) => note.text)).toEqual(["bad timestamp", "good timestamp"])
    expect(unfiltered.skipped).toBe(0)
  })

  test("staleness counts whole days, and a blank note is refused", () => {
    expect(ModelPlan.daysSince("2026-10-04", Date.parse(NOW))).toBe(10)
    expect(ModelPlan.daysSince(undefined, Date.parse(NOW))).toBeNull()
    expect(() => ModelPlan.addNote({ text: "   " }, NOW, dir())).toThrow("some text")
  })

  test("guidance points OpenCode's own plans at the console and leaves other providers without it", () => {
    expect(ModelPlan.guidance("opencode-go").join(" ")).toContain("opencode.ai/console")
    expect(ModelPlan.guidance("anthropic").join(" ")).not.toContain("opencode.ai/console")
  })
})
