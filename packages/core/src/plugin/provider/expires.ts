/**
 * Validation for OAuth `expires_in` values (#879). Five providers computed
 * the stored credential expiry as `now + (tokens.expires_in ?? fallback)`,
 * which only guards an ABSENT value: a negative or zero lifetime stored a
 * born-expired credential (the integration layer refreshes it on every
 * request), a non-finite one poisoned the comparison, and an oversized one
 * — the classic server bug of returning the lifetime in milliseconds —
 * disabled refresh for weeks, because the consumer treats the credential
 * as valid until the stored expiry. The xAI provider's local
 * `positiveSeconds` (xai.ts) is the precedent; this is the shared version
 * for the providers that never got the guard. Since #892 the xAI provider
 * uses it for its token/device lifetimes too (its local helper remains
 * only for the poll interval), and Poe clamps to the same bound.
 * DigitalOcean's string-spelling parser clamps to it too (#899).
 */

/**
 * The longest lifetime stored verbatim, in seconds (30 days). Real OAuth
 * access-token lifetimes are far shorter; anything past this bound is a
 * malformed or unit-confused response and takes the fallback instead.
 */
export const MAX_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60

/**
 * The lifetime to store for a token response: the response's own value when
 * it is a positive, finite number of seconds within the sane bound, else
 * the provider's existing default lifetime.
 */
export function expiresInSeconds(value: unknown, fallback: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_EXPIRES_IN_SECONDS ? seconds : fallback
}
