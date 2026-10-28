import { describe, expect, test } from "bun:test"
import { Effect, Logger } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { TmpStdlib } from "@opencode/core/tmp-stdlib"

const makeRoot = async (files: Record<string, string> = {}) => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tmp-stdlib-")))
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return dir
}

const removeRoot = (dir: string) => fs.rm(dir, { recursive: true, force: true })

const captured = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const messages: string[] = []
      const result = yield* effect.pipe(
        Effect.provideService(Logger.CurrentLoggers, new Set([Logger.make((entry) => messages.push(String(entry.message)))])),
      )
      return { result, messages }
    }),
  )

describe("TmpStdlib", () => {
  test("flags stdlib-named .py files", () => {
    expect(TmpStdlib.isStdlibPyFile("re.py")).toBe(true)
    expect(TmpStdlib.isStdlibPyFile("os.py")).toBe(true)
    expect(TmpStdlib.isStdlibPyFile("json.py")).toBe(true)
    expect(TmpStdlib.isStdlibPyFile("sys.py")).toBe(true)
  })

  test("ignores non-stdlib .py files", () => {
    expect(TmpStdlib.isStdlibPyFile("helper.py")).toBe(false)
    expect(TmpStdlib.isStdlibPyFile("my_re.py")).toBe(false)
  })

  test("ignores non-.py files", () => {
    expect(TmpStdlib.isStdlibPyFile("re.txt")).toBe(false)
    expect(TmpStdlib.isStdlibPyFile("re")).toBe(false)
    expect(TmpStdlib.isStdlibPyFile("re.pyc")).toBe(false)
    expect(TmpStdlib.isStdlibPyFile(".py")).toBe(false)
  })

  test("findShadows sorts hits", () => {
    expect(TmpStdlib.findShadows(["helper.py", "os.py", "notes.txt", "re.py"])).toEqual(["os.py", "re.py"])
  })

  test("message names the file and the python3 -I workaround", () => {
    const message = TmpStdlib.messageFor("/tmp/opencode", ["re.py"])
    expect(message).toContain("re.py")
    expect(message).toContain("python3 -I")
  })

  test("scan finds top-level shadows only", async () => {
    const dir = await makeRoot({ "re.py": "x = 1\n", "helper.py": "y = 2\n", "nested/os.py": "z = 3\n" })
    try {
      expect(await Effect.runPromise(TmpStdlib.scan(dir))).toEqual(["re.py"])
    } finally {
      await removeRoot(dir)
    }
  })

  test("scan stays quiet for a clean root", async () => {
    const dir = await makeRoot({ "helper.py": "y = 2\n" })
    try {
      expect(await Effect.runPromise(TmpStdlib.scan(dir))).toEqual([])
    } finally {
      await removeRoot(dir)
    }
  })

  test("scan stays quiet for an empty root", async () => {
    const dir = await makeRoot()
    try {
      expect(await Effect.runPromise(TmpStdlib.scan(dir))).toEqual([])
    } finally {
      await removeRoot(dir)
    }
  })

  test("scan stays quiet for a missing directory", async () => {
    const dir = await makeRoot()
    await removeRoot(dir)
    expect(await Effect.runPromise(TmpStdlib.scan(dir))).toEqual([])
  })

  test("checkOnce warns and leaves files untouched", async () => {
    TmpStdlib.resetWarned()
    const dir = await makeRoot({ "re.py": "import re\n" })
    try {
      const before = await fs.readFile(path.join(dir, "re.py"), "utf8")
      const { messages } = await captured(TmpStdlib.checkOnce(dir))
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain("re.py")
      expect(messages[0]).toContain("python3 -I")
      expect(await fs.readFile(path.join(dir, "re.py"), "utf8")).toBe(before)
      expect(await fs.readdir(dir)).toContain("re.py")
    } finally {
      await removeRoot(dir)
    }
  })

  test("checkOnce warns only once per root", async () => {
    TmpStdlib.resetWarned()
    const dir = await makeRoot({ "re.py": "x = 1\n" })
    try {
      expect((await captured(TmpStdlib.checkOnce(dir))).messages).toHaveLength(1)
      expect((await captured(TmpStdlib.checkOnce(dir))).messages).toEqual([])
    } finally {
      await removeRoot(dir)
    }
  })

  test("checkOnce stays quiet for a clean root", async () => {
    TmpStdlib.resetWarned()
    const dir = await makeRoot({ "helper.py": "y = 2\n" })
    try {
      expect((await captured(TmpStdlib.checkOnce(dir))).messages).toEqual([])
    } finally {
      await removeRoot(dir)
    }
  })
})
