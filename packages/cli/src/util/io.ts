import { text } from "node:stream/consumers"

export function readStdin(beforeRead?: () => void) {
  beforeRead?.()
  return text(process.stdin)
}
