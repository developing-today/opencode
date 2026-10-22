// OC_PORT comes from supervisor/unit configuration: accept only a decimal integer in port range and
// fall back to the default otherwise, instead of handing NaN, a fraction, or 0 (empty value) to the bind.
export function parsePortEnv(value: string | undefined): { port: number; invalid: boolean } {
  if (value === undefined) return { port: 4096, invalid: false }
  const parsed = /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return { port: parsed, invalid: false }
  return { port: 4096, invalid: true }
}
