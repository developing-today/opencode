import { expect, test } from "bun:test"
import path from "path"
import { mkdtemp, readdir, rename, rm } from "fs/promises"
import { tmpdir } from "os"
import { appendText, readJson, readText, renameWithRetry, writeJsonAtomic, writeText } from "../../src/util/persistence"

test("persistence creates parent directories and supports text, append, and JSON", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-persistence-"))
  try {
    const textPath = path.join(root, "nested", "state.jsonl")
    await writeText(textPath, "one\n")
    await appendText(textPath, "two\n")
    expect(await readText(textPath)).toBe("one\ntwo\n")

    const jsonPath = path.join(root, "other", "state.json")
    await writeJsonAtomic(jsonPath, { value: 1 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 1 })
    await writeJsonAtomic(jsonPath, { value: 2 })
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("writeJsonAtomic survives a transient rename EPERM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-persistence-"))
  try {
    const jsonPath = path.join(root, "state.json")
    let attempts = 0
    await writeJsonAtomic(jsonPath, { value: 42 }, async (source, destination) => {
      attempts++
      if (attempts === 1) {
        const error = new Error("operation not permitted") as Error & { code: string }
        error.code = "EPERM"
        throw error
      }
      await rename(source, destination)
    })
    expect(attempts).toBe(2)
    expect(await readJson<{ value: number }>(jsonPath)).toEqual({ value: 42 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("renameWithRetry retries EACCES and EBUSY but not other errors", async () => {
  for (const code of ["EACCES", "EBUSY"]) {
    let attempts = 0
    await renameWithRetry("source", "destination", async () => {
      attempts++
      if (attempts < 3) {
        const error = new Error(code) as Error & { code: string }
        error.code = code
        throw error
      }
    })
    expect(attempts).toBe(3)
  }

  let attempts = 0
  const failure = renameWithRetry("source", "destination", async () => {
    attempts++
    const error = new Error("no such file") as Error & { code: string }
    error.code = "ENOENT"
    throw error
  })
  await expect(failure).rejects.toThrow("no such file")
  expect(attempts).toBe(1)
})

test("writeJsonAtomic removes the temp file when rename keeps failing transiently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-tui-persistence-"))
  try {
    const jsonPath = path.join(root, "state.json")
    let attempts = 0
    const failure = writeJsonAtomic(jsonPath, { value: 1 }, async () => {
      attempts++
      const error = new Error("operation not permitted") as Error & { code: string }
      error.code = "EPERM"
      throw error
    })
    await expect(failure).rejects.toThrow("operation not permitted")
    expect(attempts).toBe(5)
    expect(await readdir(root)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
