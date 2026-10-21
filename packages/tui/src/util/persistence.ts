import path from "path"
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises"

export function readText(filePath: string) {
  return readFile(filePath, "utf8")
}

export async function readJson<T>(filePath: string) {
  return JSON.parse(await readFile(filePath, "utf8")) as T
}

export async function writeText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}

export async function appendText(filePath: string, content: string) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, content)
}

const transientRenameCodes = new Set(["EPERM", "EACCES", "EBUSY"])
const renameRetryDelays = [10, 25, 50, 100]

function isTransientRenameError(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  if (!("code" in error)) return false
  return typeof error.code === "string" && transientRenameCodes.has(error.code)
}

export async function renameWithRetry(
  source: string,
  destination: string,
  renameFile: (source: string, destination: string) => Promise<void> = rename,
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFile(source, destination)
      return
    } catch (error) {
      const delay = renameRetryDelays[attempt]
      if (delay === undefined || !isTransientRenameError(error)) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  renameFile: (source: string, destination: string) => Promise<void> = rename,
) {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value)).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
  await renameWithRetry(temporary, filePath, renameFile).catch(async (error) => {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  })
}
