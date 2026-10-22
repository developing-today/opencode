export function parseCliVersion(output: string) {
  // The bundled binary is spawned directly (no login shell), so its own version line is the
  // first version-shaped line; later lines are diagnostics whose ` v...` tokens are not versions.
  // A candidate counts only when it has the shape the remote CLI parsers accept (`local` or
  // starting with a digit), so unparseable output is rejected instead of cached as a version.
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()

    if (!line) continue
    const marker = line.lastIndexOf(" v")
    const version = marker === -1 ? line : line.slice(marker + 2)

    if (version === "local" || /^[0-9][a-zA-Z0-9.+-]*$/.test(version)) return version
  }

  throw new Error("V2 CLI did not provide a version")
}
