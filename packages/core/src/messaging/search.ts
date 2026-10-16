export * as MessagingSearch from "./search.js"

import { createHash } from "crypto"

/**
 * Text scoring shared by message and log search. Fuzzy matching uses character trigrams, the same
 * representation the SQLite FTS5 trigram index stores, so the database narrows candidates and this
 * module ranks them by how much of the query they contain, tolerating typos and partial words.
 */

export function words(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

export function trigrams(text: string): Set<string> {
  const result = new Set<string>()
  for (const word of words(text)) {
    if (word.length < 3) {
      result.add(word)
      continue
    }
    for (let index = 0; index + 3 <= word.length; index++) result.add(word.slice(index, index + 3))
  }
  return result
}

/** An FTS5 query matching any trigram of the query words, or undefined when no word has three characters. */
export function ftsQuery(query: string) {
  const grams = Array.from(trigrams(query)).filter((gram) => gram.length === 3)
  if (grams.length === 0) return undefined
  return grams.map((gram) => `"${gram.replaceAll('"', '""')}"`).join(" OR ")
}

/** An FTS5 phrase matching the exact (case-insensitive) substring, or undefined when it is too short. */
export function ftsPhrase(query: string) {
  const trimmed = query.trim()
  if (trimmed.length < 3) return undefined
  return `"${trimmed.replaceAll('"', '""')}"`
}

/**
 * Fuzzy relevance in [0, 1.5]: the share of query trigrams found in the text, plus a bonus for an
 * exact substring and for whole query words. Below about 0.35 a match is mostly noise.
 */
export function fuzzy(query: string, text: string) {
  const needle = query.trim().toLowerCase()
  if (needle === "") return 0
  const haystack = text.toLowerCase()
  const exact = haystack.includes(needle) ? 0.5 : 0
  const grams = trigrams(needle)
  if (grams.size === 0) return exact
  const present = trigrams(haystack)
  const covered = Array.from(grams).filter((gram) => present.has(gram)).length / grams.size
  const queryWords = words(needle)
  const textWords = new Set(words(haystack))
  const whole =
    queryWords.length === 0 ? 0 : queryWords.filter((word) => textWords.has(word)).length / queryWords.length
  return covered * 0.8 + whole * 0.2 + exact
}

export const FUZZY_THRESHOLD = 0.35

/** Semantic matches below this cosine similarity are dropped. */
export const SEMANTIC_FLOOR = 0.15
/** Semantic matches below this share of the best match's similarity are dropped. */
export const SEMANTIC_RELATIVE = 0.6

/** Reciprocal rank fusion of ranked key lists; higher is better. */
export function fuse(lists: ReadonlyArray<ReadonlyArray<string>>, k = 60) {
  const scores = new Map<string, number>()
  for (const list of lists) list.forEach((key, rank) => scores.set(key, (scores.get(key) ?? 0) + 1 / (k + rank + 1)))
  return scores
}

/** Dot product; vectors are L2-normalized so this is cosine similarity. */
export function cosine(left: Float32Array, right: Float32Array) {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index++) sum += left[index] * right[index]
  return sum
}

export function toBytes(vector: Float32Array) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

export function fromBytes(bytes: Uint8Array) {
  // Copy into an aligned buffer; SQLite blobs may start at any byte offset.
  return new Float32Array(Uint8Array.from(bytes).buffer)
}

export function hash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 32)
}

/** Compiles a user regex, falling back to a literal match when the pattern is invalid. */
export function pattern(query: string) {
  try {
    return new RegExp(query, "i")
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
  }
}
