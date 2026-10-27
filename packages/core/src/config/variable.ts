export * as ConfigVariable from "./variable.js"

import os from "os"
import path from "path"
import { Effect } from "effect"
import { type ParseError, parse } from "jsonc-parser"
import { FSUtil } from "@opencode/util/fs-util"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  env?: Record<string, string>
}

/** Apply {env:VAR}, {env:VAR:-fallback} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const env = (escape: boolean) => {
    let out = ""
    let cursor = 0
    for (const match of input.text.matchAll(/\{env:([^}]+)\}/g)) {
      const token = match[1]
      const index = match.index
      out += input.text.slice(cursor, index)
      cursor = index + match[0].length
      // Like {file:...} below, a reference on a // comment line is prose, not a substitution:
      // replacing it would leak the value into the comment, and a newline in the value would
      // break out of the comment and change what the config says.
      const lineStart = input.text.lastIndexOf("\n", index - 1) + 1
      if (input.text.slice(lineStart, index).trimStart().startsWith("//")) {
        out += match[0]
        continue
      }
      // Shell-style default: {env:VAR:-fallback} resolves to the fallback when VAR is unset
      // or empty, so a config can name a working default instead of silently substituting "".
      const separator = token.indexOf(":-")
      const name = separator === -1 ? token : token.slice(0, separator)
      const fallback = separator === -1 ? "" : token.slice(separator + 2)
      const value = (input.env?.[name] ?? process.env[name]) || fallback
      out += escape ? JSON.stringify(value).slice(1, -1) : value
    }
    return out + input.text.slice(cursor)
  }
  // Escape only when raw values break the JSON (e.g. Windows paths), so configs that parse today keep their meaning.
  const raw = yield* substituteFiles(input, env(false))
  const errors: ParseError[] = []
  if (input.text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  if (!errors.length) return raw
  return yield* substituteFiles(input, env(true))
})

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const fs = yield* FSUtil.Service
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    // Like a missing {env:VAR}, a missing or unreadable file substitutes empty so one stale secret
    // reference cannot take down every Location that loads this config.
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("config file reference is missing or unreadable", {
          source: configSource,
          reference: token,
          path: resolvedPath,
          cause,
        }).pipe(Effect.as("")),
      ),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  return out + text.slice(cursor)
})
