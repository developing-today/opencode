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

// The env-substituted text plus the [start, end) ranges of it that were copied from the
// config text itself. Anything outside those ranges arrived through an env value (or a
// :- fallback), so references found there were not authored in the config.
type Substituted = {
  text: string
  authored: Array<readonly [number, number]>
}

/** Apply {env:VAR}, {env:VAR:-fallback} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const env = (escape: boolean): Substituted => {
    const parts: string[] = []
    const authored: Array<readonly [number, number]> = []
    let length = 0
    let cursor = 0
    const push = (segment: string, isAuthored: boolean) => {
      if (!segment) return
      if (isAuthored) {
        const last = authored[authored.length - 1]
        if (last && last[1] === length) authored[authored.length - 1] = [last[0], length + segment.length]
        else authored.push([length, length + segment.length] as const)
      }
      parts.push(segment)
      length += segment.length
    }
    for (const match of input.text.matchAll(/\{env:([^}]+)\}/g)) {
      const token = match[1]
      push(input.text.slice(cursor, match.index), true)
      // Same comment-line guard as the file pass below: a reference on a // comment line
      // stays literal, so a commented-out example never expands — and a newline in the
      // value cannot break out of the comment into live config text.
      const lineStart = input.text.lastIndexOf("\n", match.index - 1) + 1
      if (input.text.slice(lineStart, match.index).trimStart().startsWith("//")) {
        push(match[0], true)
        cursor = match.index + match[0].length
        continue
      }
      // Shell-style default: {env:VAR:-fallback} resolves to the fallback when VAR is unset
      // or empty, so a config can name a working default instead of silently substituting "".
      const separator = token.indexOf(":-")
      const name = separator === -1 ? token : token.slice(0, separator)
      const fallback = separator === -1 ? "" : token.slice(separator + 2)
      const value = (input.env?.[name] ?? process.env[name]) || fallback
      push(escape ? JSON.stringify(value).slice(1, -1) : value, false)
      cursor = match.index + match[0].length
    }
    push(input.text.slice(cursor), true)
    return { text: parts.join(""), authored }
  }
  // Escape only when raw values break the JSON (e.g. Windows paths), so configs that parse today keep their meaning.
  const raw = yield* substituteFiles(input, env(false))
  const errors: ParseError[] = []
  if (input.text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  if (!errors.length) return raw
  return yield* substituteFiles(input, env(true))
})

/** Whether a reference at the end of `prefix` — the config text before it, back to the start of
 * its line — sits inside a // comment. A // outside any string starts the comment (at the line
 * start or trailing live code); a // inside a string value, like a URL's, does not. */
const inComment = (prefix: string) => {
  let inString = false
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i]
    if (inString) {
      if (char === "\\") i++
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === "/" && prefix[i + 1] === "/") return true
  }
  return false
}

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, substituted: Substituted) {
  const fs = yield* FSUtil.Service
  const text = substituted.text
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    // Only expand references the config itself authored: a {file:...} that arrived inside
    // an env value or fallback stays literal, so env contents cannot read local files
    // into the config.
    const authored = substituted.authored.some(([start, end]) => index >= start && index + token.length <= end)
    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    if (!authored || inComment(text.slice(lineStart, index))) {
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
