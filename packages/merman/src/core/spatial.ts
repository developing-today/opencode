import { orthogonalPathPoints, type DiagramBounds, type DiagramPoint } from "./geometry.js"

export type SpatialRole = "body" | "boundary" | "terminal" | "route" | "label"

export interface SpatialSpan {
  readonly y: number
  readonly fromX: number
  readonly toX: number
}

export interface SpatialClaim {
  readonly id: string
  readonly owner: string
  readonly role: SpatialRole
  readonly spans: readonly SpatialSpan[]
}

export interface SpatialContact {
  owner: string
  points: readonly DiagramPoint[]
}

export interface SpatialConflict {
  moving: SpatialClaim
  existing: SpatialClaim
  point: DiagramPoint
}

export interface SpatialClearance {
  x: number
  y: number
}

export interface SpatialCollisionPolicy {
  contacts?: readonly SpatialContact[]
  clearance?: number | SpatialClearance | Partial<Record<SpatialRole, number | SpatialClearance>>
}

function normalizedSpan(y: number, fromX: number, toX: number): SpatialSpan {
  return { y, fromX: Math.min(fromX, toX), toX: Math.max(fromX, toX) }
}

function assertFiniteInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new RangeError(`${name} must be a finite integer`)
}

export function spatialRectSpans(bounds: Pick<DiagramBounds, "left" | "top" | "width" | "height">): SpatialSpan[] {
  assertFiniteInteger(bounds.left, "bounds.left")
  assertFiniteInteger(bounds.top, "bounds.top")
  assertFiniteInteger(bounds.width, "bounds.width")
  assertFiniteInteger(bounds.height, "bounds.height")
  if (bounds.width <= 0 || bounds.height <= 0) throw new RangeError("Spatial bounds must have positive dimensions")
  return Array.from({ length: bounds.height }, (_, offset) =>
    normalizedSpan(bounds.top + offset, bounds.left, bounds.left + bounds.width - 1),
  )
}

export function spatialPathSpans(points: readonly DiagramPoint[]): SpatialSpan[] {
  for (const [index, point] of points.entries()) {
    assertFiniteInteger(point.x, `points[${index}].x`)
    assertFiniteInteger(point.y, `points[${index}].y`)
    if (index > 0 && point.x !== points[index - 1]!.x && point.y !== points[index - 1]!.y) {
      throw new RangeError("Spatial paths must be orthogonal")
    }
  }
  const cells = new Map<number, Set<number>>()
  const add = (point: DiagramPoint): void => {
    const row = cells.get(point.y) ?? new Set<number>()
    row.add(point.x)
    cells.set(point.y, row)
  }

  if (points.length === 1) add(points[0]!)
  for (const point of orthogonalPathPoints(points)) add(point)

  return [...cells.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([y, xs]) => {
      const sorted = [...xs].sort((left, right) => left - right)
      const [first, ...rest] = sorted
      if (first === undefined) return []
      const spans: SpatialSpan[] = []
      let start = first
      let end = first
      for (const x of rest) {
        if (x === end + 1) {
          end = x
          continue
        }
        spans.push(normalizedSpan(y, start, end))
        start = x
        end = x
      }
      spans.push(normalizedSpan(y, start, end))
      return spans
    })
}

export function spatialRectClaim(
  id: string,
  owner: string,
  role: SpatialRole,
  bounds: Pick<DiagramBounds, "left" | "top" | "width" | "height">,
): SpatialClaim {
  return { id, owner, role, spans: spatialRectSpans(bounds) }
}

export function spatialPathClaim(
  id: string,
  owner: string,
  role: Extract<SpatialRole, "boundary" | "route">,
  points: readonly DiagramPoint[],
): SpatialClaim {
  return { id, owner, role, spans: spatialPathSpans(points) }
}

function compareClaims(left: SpatialClaim, right: SpatialClaim): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function sameClaim(left: SpatialClaim, right: SpatialClaim): boolean {
  return (
    left.id === right.id &&
    left.owner === right.owner &&
    left.role === right.role &&
    left.spans.length === right.spans.length &&
    left.spans.every(
      (span, index) =>
        span.y === right.spans[index]!.y &&
        span.fromX === right.spans[index]!.fromX &&
        span.toX === right.spans[index]!.toX,
    )
  )
}

function pointIsContact(point: DiagramPoint, existing: SpatialClaim, contacts: readonly SpatialContact[]): boolean {
  return contacts.some(
    (contact) =>
      contact.owner === existing.owner &&
      contact.points.some((candidate) => candidate.x === point.x && candidate.y === point.y),
  )
}

function rolesMayOverlap(moving: SpatialClaim, existing: SpatialClaim): boolean {
  if (moving.owner === existing.owner) return true
  return moving.role === "route" && existing.role === "route"
}

function normalizeClearance(clearance: number | SpatialClearance | undefined): SpatialClearance {
  const x = typeof clearance === "number" ? clearance : (clearance?.x ?? 0)
  const y = typeof clearance === "number" ? clearance : (clearance?.y ?? 0)
  assertFiniteInteger(x, "clearance.x")
  assertFiniteInteger(y, "clearance.y")
  if (x < 0 || y < 0) throw new RangeError("Spatial clearance cannot be negative")
  return { x, y }
}

function inflateSpan(span: SpatialSpan, clearance: SpatialClearance): SpatialSpan {
  return { y: span.y, fromX: span.fromX - clearance.x, toX: span.toX + clearance.x }
}

const noSpans: readonly SpatialSpan[] = []

function spansByRow(spans: readonly SpatialSpan[]): ReadonlyMap<number, readonly SpatialSpan[]> {
  const rows = new Map<number, SpatialSpan[]>()
  for (const span of spans) {
    const row = rows.get(span.y)
    if (row) {
      row.push(span)
      continue
    }
    rows.set(span.y, [span])
  }
  return rows
}

function spanBounds(spans: readonly SpatialSpan[]) {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const span of spans) {
    minX = Math.min(minX, span.fromX)
    maxX = Math.max(maxX, span.toX)
    minY = Math.min(minY, span.y)
    maxY = Math.max(maxY, span.y)
  }
  return { minX, maxX, minY, maxY }
}

function indexClaims(claims: readonly SpatialClaim[]) {
  return {
    rows: claims.map((claim) => spansByRow(claim.spans)),
    bounds: claims.map((claim) => spanBounds(claim.spans)),
  }
}

// A claim's bounds, inflated by its clearance, must reach the moving bounds before any span can conflict.
function mayReach(
  bounds: ReturnType<typeof spanBounds>,
  moving: ReturnType<typeof spanBounds>,
  clearance: SpatialClearance,
): boolean {
  return (
    bounds.minY <= moving.maxY + clearance.y &&
    bounds.maxY >= moving.minY - clearance.y &&
    bounds.minX <= moving.maxX + clearance.x &&
    bounds.maxX >= moving.minX - clearance.x
  )
}

function roleClearance(policy: SpatialCollisionPolicy, role: SpatialRole): SpatialClearance {
  return normalizeClearance(
    typeof policy.clearance === "number" || (policy.clearance && "x" in policy.clearance)
      ? policy.clearance
      : policy.clearance?.[role],
  )
}

export class SpatialIndex {
  static empty(): SpatialIndex {
    return new SpatialIndex([])
  }

  readonly claims: readonly SpatialClaim[]
  private claimIndex?: ReturnType<typeof indexClaims>

  private constructor(claims: readonly SpatialClaim[]) {
    this.claims = Object.freeze(
      claims.map((claim) =>
        Object.freeze({
          ...claim,
          spans: Object.freeze(
            [...claim.spans]
              .map((span) => Object.freeze({ ...span }))
              .sort((left, right) => left.y - right.y || left.fromX - right.fromX || left.toX - right.toX),
          ),
        }),
      ),
    )
  }

  add(...claims: readonly SpatialClaim[]): SpatialIndex {
    return this.overlay(new SpatialIndex(claims))
  }

  overlay(other: SpatialIndex): SpatialIndex {
    const claims = new Map(this.claims.map((claim) => [claim.id, claim]))
    for (const claim of other.claims) {
      const existing = claims.get(claim.id)
      if (existing && !sameClaim(existing, claim)) throw new Error(`Conflicting spatial claim id: ${claim.id}`)
      claims.set(claim.id, claim)
    }
    return new SpatialIndex([...claims.values()].sort(compareClaims))
  }

  conflicts(moving: SpatialClaim, policy: SpatialCollisionPolicy = {}): SpatialConflict[] {
    return this.scanConflicts(moving, policy, false)
  }

  isFree(claim: SpatialClaim, policy: SpatialCollisionPolicy = {}): boolean {
    return this.scanConflicts(claim, policy, true).length === 0
  }

  // Claims whose bounds cannot reach the moving bounds are skipped, and firstOnly stops at the first conflict.
  private scanConflicts(moving: SpatialClaim, policy: SpatialCollisionPolicy, firstOnly: boolean): SpatialConflict[] {
    const contacts = policy.contacts ?? []
    const conflicts: SpatialConflict[] = []
    const { rows, bounds } = (this.claimIndex ??= indexClaims(this.claims))
    const movingBounds = spanBounds(moving.spans)
    const clearances: Partial<Record<SpatialRole, SpatialClearance>> = {}
    // Validate every claim's clearance before any early return, so an invalid policy throws the same way for isFree.
    for (const existing of this.claims) {
      if (!rolesMayOverlap(moving, existing)) clearances[existing.role] ??= roleClearance(policy, existing.role)
    }
    let movingRows: ReadonlyMap<number, readonly SpatialSpan[]> | undefined

    for (const [index, existing] of this.claims.entries()) {
      if (rolesMayOverlap(moving, existing)) continue
      const clearance = clearances[existing.role]!
      if (!mayReach(bounds[index]!, movingBounds, clearance)) continue
      const existingRows = rows[index]!
      for (const movingSpan of moving.spans) {
        for (let dy = -clearance.y; dy <= clearance.y; dy++) {
          const inflated = inflateSpan({ ...movingSpan, y: movingSpan.y + dy }, clearance)
          for (const existingSpan of existingRows.get(inflated.y) ?? noSpans) {
            const fromX = Math.max(inflated.fromX, existingSpan.fromX)
            const toX = Math.min(inflated.toX, existingSpan.toX)
            for (let x = fromX; x <= toX; x++) {
              const point = { x, y: inflated.y }
              movingRows ??= spansByRow(moving.spans)
              const movingOccupiesPoint = (movingRows.get(point.y) ?? noSpans).some(
                (span) => point.x >= span.fromX && point.x <= span.toX,
              )
              if (movingOccupiesPoint && pointIsContact(point, existing, contacts)) continue
              conflicts.push({ moving, existing, point })
              if (firstOnly) return conflicts
            }
          }
        }
      }
    }

    return conflicts
  }

  firstFit<T extends { claim: SpatialClaim }>(
    candidates: readonly T[],
    policy: SpatialCollisionPolicy = {},
  ): T | undefined {
    return candidates.find((candidate) => this.isFree(candidate.claim, policy))
  }
}
