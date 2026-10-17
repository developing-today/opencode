export interface MessagingKind {
  readonly name: string
  readonly description: string
  /** Hidden kinds are excluded from reads unless a query requests them by kind. */
  readonly hidden?: boolean
}
