export * as ModelRouteSchedule from "./model-route-schedule.js"

/**
 * Recurring time windows for routing rules: a date and time-of-day filter the operator (or a
 * sentence the interpreter understood) attaches to a weight change. A window never talks to the
 * provider; it only says when a rule is in force, so the same structure describes "weekdays 9 to
 * 5 America/Chicago" and "the 1st and 15th of every month".
 *
 * Canonical shape, as stored in config and override files:
 *
 *   { "daysOfWeek": ["mon", "tue"], "start": "09:00", "end": "17:00", "timezone": "America/Chicago" }
 *
 * `parse` normalizes the friendly forms (day names, "9:30") to this shape and rejects an object it
 * cannot read, so a typo makes a rule disappear rather than apply at the wrong time. `active`
 * evaluates it; a window with no constraints is always active.
 */
export interface Window {
  /** 0 (Sunday) to 6 (Saturday). Empty or absent means every day. */
  readonly daysOfWeek?: readonly number[]
  /** 1 to 31, plus -1 for the last day of the month. Empty or absent means every day. */
  readonly daysOfMonth?: readonly number[]
  /** Local start of the daily window, "HH:mm". Absent means from the start of the day. */
  readonly start?: string
  /** Local end of the daily window, "HH:mm", exclusive. Absent means to the end of the day. */
  readonly end?: string
  /** IANA timezone such as "America/Chicago"; absent means the host's local timezone. */
  readonly timezone?: string
  /** First instant the window may be active, epoch milliseconds. */
  readonly from?: number
  /** Last instant the window may be active, epoch milliseconds; exclusive. */
  readonly until?: number
}

const DAY_NAMES: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
}

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

const field = (value: unknown, name: string) =>
  value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined

/** A day number from a number, a numeric string, or a case-insensitive day name. */
const dayOfWeek = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6) return value
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase()
  if (/^[0-6]$/.test(text)) return Number(text)
  return DAY_NAMES[text]
}

/** A day of month from a number or numeric string: 1..31, or -1 for the last day. */
const dayOfMonth = (value: unknown): number | undefined => {
  const number = typeof value === "string" && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : value
  if (typeof number !== "number" || !Number.isInteger(number)) return undefined
  if (number === -1 || (number >= 1 && number <= 31)) return number
  return undefined
}

export const isDayOfWeek = (value: unknown): value is number | string => dayOfWeek(value) !== undefined
export const isDayOfMonth = (value: unknown): value is number | string => dayOfMonth(value) !== undefined

/** "9:30", "09:30", "23:59", "9:5" or "9:30:15" as minutes since local midnight. Seconds round down. */
export const minutesOf = (value: string): number | undefined => {
  const match = /^(\d{1,2}):(\d{1,2})(?::\d{2})?$/.exec(value.trim())
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return undefined
  return hours * 60 + minutes
}

/** "9:30" as canonical "HH:mm". */
export const normalizeTime = (value: string): string | undefined => {
  const minutes = minutesOf(value)
  if (minutes === undefined) return undefined
  const hours = Math.floor(minutes / 60)
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

const timezoneFormat = (timezone: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
  } catch {
    return undefined
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The canonical IANA name for a timezone, or undefined when the runtime does not know it. */
export const timezoneName = (value: string): string | undefined => {
  const format = timezoneFormat(value)
  return format?.resolvedOptions().timeZone
}

const formatterFor = (timezone: string | undefined) => {
  const key = timezone ?? ""
  const cached = formatters.get(key)
  if (cached) return cached
  // An invalid name is refused at parse time; a window built by hand falls back to the host zone
  // rather than making a routing decision throw.
  const format =
    (timezone === undefined ? undefined : timezoneFormat(key)) ??
    new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
  formatters.set(key, format)
  return format
}

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly dayOfMonth: number
  readonly dayOfWeek: number
  readonly minutes: number
}

const SHORT_DAYS: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const partsAt = (format: Intl.DateTimeFormat, at: number): LocalParts => {
  const values: Record<string, string> = {}
  for (const part of format.formatToParts(new Date(at))) if (part.type !== "literal") values[part.type] = part.value
  return {
    year: Number(values.year),
    month: Number(values.month),
    dayOfMonth: Number(values.day),
    dayOfWeek: SHORT_DAYS[values.weekday.toLowerCase()] ?? 0,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  }
}

const daysInMonth = (parts: Pick<LocalParts, "year" | "month">) =>
  // Day 0 of the following month is the last day of this one.
  new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate()

/**
 * Reads a window from user input. Returns undefined when the object is not a window at all (an
 * invalid timezone, an unreadable day list or time), and an always-active window for `{}`. Fields
 * that read as empty lists are dropped so the canonical value is as small as the config.
 */
export const parse = (value: unknown): Window | undefined => {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") return undefined
  const result: {
    daysOfWeek?: number[]
    daysOfMonth?: number[]
    start?: string
    end?: string
    timezone?: string
    from?: number
    until?: number
  } = {}

  const rawDaysOfWeek = field(value, "daysOfWeek")
  if (rawDaysOfWeek !== undefined) {
    if (!Array.isArray(rawDaysOfWeek)) return undefined
    const days = [...new Set(rawDaysOfWeek.map(dayOfWeek).filter((day): day is number => day !== undefined))].sort(
      (left, right) => left - right,
    )
    if (days.length === 0) return undefined
    result.daysOfWeek = days
  }

  const rawDaysOfMonth = field(value, "daysOfMonth")
  if (rawDaysOfMonth !== undefined) {
    if (!Array.isArray(rawDaysOfMonth)) return undefined
    const days = [...new Set(rawDaysOfMonth.map(dayOfMonth).filter((day): day is number => day !== undefined))]
    if (days.length === 0) return undefined
    result.daysOfMonth = days
  }

  const rawStart = field(value, "start")
  if (rawStart !== undefined) {
    if (typeof rawStart !== "string") return undefined
    const start = normalizeTime(rawStart)
    if (start === undefined) return undefined
    result.start = start
  }

  const rawEnd = field(value, "end")
  if (rawEnd !== undefined) {
    if (typeof rawEnd !== "string") return undefined
    const end = normalizeTime(rawEnd)
    if (end === undefined) return undefined
    result.end = end
  }

  const rawTimezone = field(value, "timezone")
  if (rawTimezone !== undefined) {
    const canonical = typeof rawTimezone === "string" ? timezoneName(rawTimezone.trim()) : undefined
    if (canonical === undefined) return undefined
    result.timezone = canonical
  }

  for (const [name, key] of [
    ["from", "from"],
    ["until", "until"],
  ] as const) {
    const raw = field(value, name)
    if (raw === undefined) continue
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
    result[key] = raw
  }
  if (result.from !== undefined && result.until !== undefined && result.from >= result.until) return undefined

  return result
}

const dayMatches = (window: Window, parts: LocalParts) =>
  (!window.daysOfWeek?.length || window.daysOfWeek.includes(parts.dayOfWeek)) &&
  (!window.daysOfMonth?.length ||
    window.daysOfMonth.some((day) => day === parts.dayOfMonth || (day === -1 && parts.dayOfMonth === daysInMonth(parts))))

const minuteMatches = (window: Window, minutes: number) => {
  const start = window.start === undefined ? undefined : minutesOf(window.start)
  const end = window.end === undefined ? undefined : minutesOf(window.end)
  if (start === undefined && end === undefined) return true
  if (start === undefined) return minutes < end!
  if (end === undefined) return minutes >= start
  if (start === end) return false
  if (start < end) return minutes >= start && minutes < end
  // A window that runs past midnight: the tail belongs to the day it started on.
  return minutes >= start || minutes < end
}

/** True while the wall clock in the window's timezone is inside it. */
export const active = (window: Window, now = Date.now()): boolean => {
  if (window.from !== undefined && now < window.from) return false
  if (window.until !== undefined && now >= window.until) return false
  const hasDays = Boolean(window.daysOfWeek?.length || window.daysOfMonth?.length)
  const hasTime = window.start !== undefined || window.end !== undefined
  if (!hasDays && !hasTime) return true
  const format = formatterFor(window.timezone)
  const current = partsAt(format, now)
  if (!minuteMatches(window, current.minutes)) return false
  if (!hasDays) return true
  const wraps =
    window.start !== undefined && window.end !== undefined && minutesOf(window.start)! > minutesOf(window.end)!
  if (wraps && current.minutes < minutesOf(window.end)!)
    // Before the end of a wrapping window means it began on the previous local day.
    return dayMatches(window, partsAt(format, now - (current.minutes + 1) * 60_000))
  return dayMatches(window, current)
}

const dayList = (window: Window) =>
  window.daysOfWeek?.length ? window.daysOfWeek.map((day) => DAY_LABELS[day]).join(", ") : "every day"

const monthList = (window: Window) =>
  window.daysOfMonth?.length
    ? window.daysOfMonth.map((day) => (day === -1 ? "last day" : String(day))).join(", ")
    : undefined

const timeRange = (window: Window) => {
  if (window.start === undefined && window.end === undefined) return "all day"
  if (window.start !== undefined && window.end === undefined) return `from ${window.start}`
  if (window.start === undefined) return `until ${window.end}`
  return `${window.start}-${window.end}`
}

/** A one-line English summary, used in logs and by editors that show a rule back to its author. */
export const describe = (window: Window): string => {
  const when = `${dayList(window)} ${timeRange(window)}`
  const month = monthList(window)
  const zone = window.timezone ? ` (${window.timezone})` : ""
  const bounds =
    window.from !== undefined || window.until !== undefined
      ? ` between ${window.from === undefined ? "always" : new Date(window.from).toISOString()} and ${
          window.until === undefined ? "always" : new Date(window.until).toISOString()
        }`
      : ""
  return `${month ? `${when}; day ${month} of the month` : when}${zone}${bounds}`
}
