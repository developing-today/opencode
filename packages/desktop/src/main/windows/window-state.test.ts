import { describe, expect, spyOn, test } from "bun:test"
import fs, { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { manageWindowState, readWindowState, resolveWindowState } from "./window-state"

const defaults = { width: 1280, height: 800 }

const primary = { x: 0, y: 0, width: 1920, height: 1080 }

const displays = {
  all: () => [primary, { x: 1920, y: 0, width: 2560, height: 1440 }],
  primary: () => primary,
  matching: () => primary,
}

describe("window state", () => {
  test("keeps bounds that still fit on a display", () => {
    const saved = {
      x: 2000,
      y: 100,
      width: 1000,
      height: 700,
      displayBounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    }

    expect(resolveWindowState(saved, defaults, displays)).toEqual(saved)
  })

  test("falls back to the default size on the primary display when the saved display is gone", () => {
    const saved = {
      x: 5000,
      y: 100,
      width: 1000,
      height: 700,
      displayBounds: { x: 4480, y: 0, width: 1920, height: 1080 },
    }

    expect(resolveWindowState(saved, defaults, displays)).toEqual({ ...defaults, x: 0, y: 0, displayBounds: primary })
  })

  test("uses defaults without a position when nothing usable was saved", () => {
    expect(resolveWindowState(undefined, defaults, displays)).toEqual(defaults)
    expect(resolveWindowState({ width: 0, height: -1 }, defaults, displays)).toEqual(defaults)
    expect(resolveWindowState("junk", defaults, displays)).toEqual(defaults)
  })

  test("keeps a maximized flag even without bounds", () => {
    expect(resolveWindowState({ isMaximized: true }, defaults, displays)).toEqual({ ...defaults, isMaximized: true })
  })

  test("the closing write retries a transient rename failure and leaves no temp file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-window-state-"))
    const file = path.join(dir, "window-state-a.json")
    const handlers = new Map<string, () => void>()

    const win = {
      maximize: () => undefined,
      setFullScreen: () => undefined,
      isDestroyed: () => false,
      getBounds: () => ({ x: 10, y: 20, width: 1280, height: 800 }),
      isMaximized: () => false,
      isMinimized: () => false,
      isFullScreen: () => false,
      on: (event: string, handler: () => void) => handlers.set(event, handler),
      off: (event: string) => handlers.delete(event),
    }

    // SAFETY: the fake implements only the BrowserWindow members manageWindowState calls (event
    // registration, bounds and state queries); the rest of the interface is never reached.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
    const browserWindow = win as unknown as Parameters<typeof manageWindowState>[0]

    manageWindowState(browserWindow, file, { width: 1280, height: 800 }, displays)
    const rename = fs.renameSync
    let calls = 0

    const spy = spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      calls += 1

      if (calls === 1) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      rename(source, destination)
    })

    try {
      handlers.get("close")?.()
      handlers.get("closed")?.()
      expect(calls).toBe(2)
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ x: 10, y: 20, width: 1280, height: 800 })
      expect(existsSync(`${file}.tmp`)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  test("reads the file electron-window-state wrote and ignores an unreadable one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opencode-window-state-"))
    const file = path.join(dir, "window-state-a.json")
    writeFileSync(
      file,
      '{"width":1280,"height":800,"x":0,"y":0,"displayBounds":{"x":0,"y":0,"width":3440,"height":1440},"isMaximized":false,"isFullScreen":false}',
    )
    expect(resolveWindowState(readWindowState(file), defaults, displays)).toEqual({
      width: 1280,
      height: 800,
      x: 0,
      y: 0,
      displayBounds: { x: 0, y: 0, width: 3440, height: 1440 },
      isMaximized: false,
      isFullScreen: false,
    })
    writeFileSync(file, "{oops")
    expect(readWindowState(file)).toBeUndefined()
    expect(readWindowState(path.join(dir, "missing.json"))).toBeUndefined()
  })
})
