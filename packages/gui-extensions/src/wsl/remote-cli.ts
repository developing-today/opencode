// The part of the SSH extension's remote CLI scripts that WSL uses. Extensions share only contracts, so
// keep the two copies in step.

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function requireVersion(version: string) {
  if (version !== "local" && !/^[0-9][a-zA-Z0-9.+-]*$/.test(version)) throw new Error(version)

  return version
}

export function discoverScript() {
  return `cli=""
if [ -z "$cli" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then cli="$HOME/.opencode/bin/opencode"; fi
if [ -n "$cli" ]; then printf '%s\\n' "$cli"; fi
`
}

// Adapters supply a quoted shell expression, including remote HOME or wslpath expansion.
export function versionScript(command: string) {
  return `if [ -x ${command} ]; then ${command} --version 2>/dev/null || true; fi\n`
}

export function parseVersion(output: string) {
  // The transport is a login shell (`sh -lc`), so a banner, MOTD or profile echo can precede
  // the version line on stdout. Scan for a line whose version candidate matches the shape
  // requireVersion accepts instead of trusting the first non-empty line.
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()

    if (!line) continue
    const marker = line.lastIndexOf(" v")
    const version = marker === -1 ? line : line.slice(marker + 2)

    if (version === "local" || /^[0-9][a-zA-Z0-9.+-]*$/.test(version)) return version
  }

  return null
}

/** The managed CLI installer also configures the user's shell PATH. */
export function installScript(input: { version: string; binary?: string }) {
  const version = requireVersion(input.version)

  return `set -eu
curl -fsSL https://raw.githubusercontent.com/anomalyco/opencode/v2/install | bash -s -- ${input.binary ? `--binary ${input.binary}` : `--version ${quote(version)}`}
test "$("$HOME/.opencode/bin/opencode" --version | awk '{print $NF}' | sed 's/^v//')" = ${quote(version)}
`
}
