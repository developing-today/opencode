import { describe, expect, test } from "bun:test"
import { Result } from "effect"
import { ModelRouteSchedule } from "@opencode/core/model-route-schedule"

// January 5, 2026 is a Monday; 15:00 UTC is mid-afternoon there.
const monday = Date.UTC(2026, 0, 5, 15, 0)
const HOUR = 3_600_000

describe("ModelRouteSchedule.parse", () => {
  test("normalizes names, numbers and times to one canonical shape", () => {
    expect(
      ModelRouteSchedule.parse({ daysOfWeek: ["Mon", 5, "saturday"], start: "9:5", end: "17:00" }),
    ).toEqual({ daysOfWeek: [1, 5, 6], start: "09:05", end: "17:00" })
    expect(ModelRouteSchedule.parse({ daysOfMonth: ["1", 15, -1] })).toEqual({ daysOfMonth: [1, 15, -1] })
    expect(ModelRouteSchedule.parse({ start: "9:30:59" })).toEqual({ start: "09:30" })
    expect(ModelRouteSchedule.parse({})).toEqual({})
  })

  test("refuses a window it cannot read instead of guessing", () => {
    expect(ModelRouteSchedule.parse("weekdays")).toBeUndefined()
    expect(ModelRouteSchedule.parse({ timezone: "Mars/Olympus" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "25:00" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "9:30:60" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ end: "17:00:99" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ end: "noon" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["someday"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [0, 42] })).toBeUndefined()
    // A mixed list is rejected too: dropping the unreadable entry would narrow the window.
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", "frieday"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", 7] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [1, 32] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [15, 0] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ from: 100, until: 100 })).toBeUndefined()
  })

  // The schema, the Window type and `active` all say an empty day list means every day; parse used to
  // refuse it, which dropped the whole schedule without a word.
  test("an empty day list means every day, as an absent one does", () => {
    expect(ModelRouteSchedule.parse({ daysOfWeek: [] })).toEqual({})
    expect(ModelRouteSchedule.parse({ daysOfMonth: [], start: "09:00", timezone: "UTC" })).toEqual({
      start: "09:00",
      timezone: "UTC",
    })
    const window = ModelRouteSchedule.parse({ daysOfWeek: [], daysOfMonth: [], start: "09:00", timezone: "UTC" })
    expect(window).toBeDefined()
    // 15:00 UTC on each day from Monday to Sunday.
    const week = Array.from({ length: 7 }, (_, day) => monday + day * 24 * HOUR)
    expect(week.map((at) => ModelRouteSchedule.active(window!, at))).toEqual(week.map(() => true))
  })

  test("keeps named days from every conventional spelling", () => {
    const parsed = ModelRouteSchedule.parse({ daysOfWeek: ["tues", "thurs", "sun"] })
    expect(parsed?.daysOfWeek).toEqual([0, 2, 4])
  })
})

describe("ModelRouteSchedule.read", () => {
  test("names every field it cannot use, so the config loader can report them", () => {
    const result = ModelRouteSchedule.read({
      start: "9am",
      end: "25:00",
      timezone: "Mars/Olympus",
      from: 2_000,
      until: 1_000,
    })
    expect(Result.isFailure(result) ? result.failure : []).toEqual([
      { path: ["start"], message: 'start "9am" is not HH:mm' },
      { path: ["end"], message: 'end "25:00" is not HH:mm' },
      { path: ["timezone"], message: 'timezone "Mars/Olympus" is not a known IANA timezone' },
      { path: ["until"], message: "until is not after from, so the window never opens" },
    ])
  })

  test("agrees with parse on a window it can read", () => {
    const input = { daysOfWeek: ["fri", "mon"], start: "9:00", timezone: "America/Chicago" }
    const result = ModelRouteSchedule.read(input)
    expect(Result.isSuccess(result) ? result.success : undefined).toEqual(ModelRouteSchedule.parse(input))
    expect(ModelRouteSchedule.parse(input)).toEqual({ daysOfWeek: [1, 5], start: "09:00", timezone: "America/Chicago" })
  })
})

describe("ModelRouteSchedule.active", () => {
  test("a window with no constraints is always active", () => {
    expect(ModelRouteSchedule.active({}, monday)).toBe(true)
  })

  test("weekdays and times are judged in the window's timezone", () => {
    const window = ModelRouteSchedule.parse({
      daysOfWeek: ["mon"],
      start: "09:00",
      end: "17:00",
      timezone: "UTC",
    })!
    expect(ModelRouteSchedule.active(window, monday)).toBe(true)
    expect(ModelRouteSchedule.active(window, monday + 3 * HOUR)).toBe(false) // 18:00
    expect(ModelRouteSchedule.active(window, monday + 24 * HOUR)).toBe(false) // Tuesday
  })

  test("a timezone moves the wall clock the days are read on", () => {
    // 01:00 UTC on Monday is Sunday evening in Chicago.
    const window = ModelRouteSchedule.parse({
      daysOfWeek: ["sun"],
      start: "18:00",
      end: "23:00",
      timezone: "America/Chicago",
    })!
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 5, 1, 0))).toBe(true)
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 0, 5, 6, 0))).toBe(false)
  })

  test("a window that starts before midnight runs into the following morning", () => {
    const window = ModelRouteSchedule.parse({ daysOfWeek: ["mon"], start: "22:00", end: "02:00", timezone: "UTC" })!
    expect(ModelRouteSchedule.active(window, monday + 7 * HOUR)).toBe(true) // Mon 22:00
    expect(ModelRouteSchedule.active(window, monday + 9 * HOUR)).toBe(true) // Tue 01:00
    expect(ModelRouteSchedule.active(window, monday + 11 * HOUR)).toBe(false) // Tue 03:00
    expect(ModelRouteSchedule.active(window, monday - 2 * HOUR)).toBe(false) // Sun 13:00
  })

  test("an end with no start means until that time, and a start with no end means from it", () => {
    const morning = ModelRouteSchedule.parse({ daysOfWeek: ["mon"], end: "09:00", timezone: "UTC" })!
    expect(ModelRouteSchedule.active(morning, monday - 7 * HOUR)).toBe(true) // Mon 08:00
    expect(ModelRouteSchedule.active(morning, monday)).toBe(false)
    const late = ModelRouteSchedule.parse({ daysOfWeek: ["mon"], start: "18:00", timezone: "UTC" })!
    expect(ModelRouteSchedule.active(late, monday + 4 * HOUR)).toBe(true)
    expect(ModelRouteSchedule.active(late, monday)).toBe(false)
  })

  test("days of month match, including the last day", () => {
    const fifth = ModelRouteSchedule.parse({ daysOfMonth: [5] })!
    expect(ModelRouteSchedule.active(fifth, monday)).toBe(true)
    expect(ModelRouteSchedule.active(fifth, monday + 24 * HOUR)).toBe(false)
    const last = ModelRouteSchedule.parse({ daysOfMonth: [-1] })!
    expect(ModelRouteSchedule.active(last, Date.UTC(2026, 0, 31, 12, 0))).toBe(true)
    expect(ModelRouteSchedule.active(last, Date.UTC(2026, 1, 28, 12, 0))).toBe(true)
    expect(ModelRouteSchedule.active(last, Date.UTC(2026, 0, 30, 12, 0))).toBe(false)
  })

  test("absolute bounds end a recurring window", () => {
    const window = ModelRouteSchedule.parse({ start: "00:00", from: monday, until: monday + HOUR })!
    expect(ModelRouteSchedule.active(window, monday + 30 * 60_000)).toBe(true)
    expect(ModelRouteSchedule.active(window, monday + 2 * HOUR)).toBe(false)
    expect(ModelRouteSchedule.active(window, monday - 1)).toBe(false)
  })

  test("an equal start and end is an empty window, not a full day", () => {
    const window = ModelRouteSchedule.parse({ start: "09:00", end: "09:00" })!
    expect(ModelRouteSchedule.active(window, monday)).toBe(false)
  })
})
