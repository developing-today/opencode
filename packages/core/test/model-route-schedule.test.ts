import { describe, expect, test } from "bun:test"
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
    // Single-digit seconds are accepted like single-digit hours and minutes (#528).
    expect(ModelRouteSchedule.parse({ start: "9:30:5" })).toEqual({ start: "09:30" })
    expect(ModelRouteSchedule.parse({ end: "17:00:9" })).toEqual({ end: "17:00" })
    expect(ModelRouteSchedule.parse({})).toEqual({})
  })

  test("refuses a window it cannot read instead of guessing", () => {
    expect(ModelRouteSchedule.parse("weekdays")).toBeUndefined()
    expect(ModelRouteSchedule.parse({ timezone: "Mars/Olympus" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "25:00" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ start: "9:30:60" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ end: "17:00:99" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ end: "noon" })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: [] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [0, 42] })).toBeUndefined()
    // A mixed list is rejected too: dropping the unreadable entry would narrow the window.
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", "frieday"] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfWeek: ["mon", 7] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [1, 32] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ daysOfMonth: [15, 0] })).toBeUndefined()
    expect(ModelRouteSchedule.parse({ from: 100, until: 100 })).toBeUndefined()
  })

  test("keeps named days from every conventional spelling", () => {
    const parsed = ModelRouteSchedule.parse({ daysOfWeek: ["tues", "thurs", "sun"] })
    expect(parsed?.daysOfWeek).toEqual([0, 2, 4])
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

  test("a wrapping window's tail belongs to the previous day on the DST fall-back night", () => {
    // DST ends in Chicago on Sun 2026-11-01: 02:00 CDT falls back to 01:00 CST, so 01:30 occurs twice.
    const saturday = ModelRouteSchedule.parse({
      daysOfWeek: ["sat"],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    const sunday = ModelRouteSchedule.parse({
      daysOfWeek: ["sun"],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    const first = Date.UTC(2026, 10, 1, 6, 30) // Sun 01:30 CDT, first occurrence
    const repeated = Date.UTC(2026, 10, 1, 7, 30) // Sun 01:30 CST, repeated hour
    expect(ModelRouteSchedule.active(saturday, first)).toBe(true)
    expect(ModelRouteSchedule.active(saturday, repeated)).toBe(true)
    expect(ModelRouteSchedule.active(saturday, Date.UTC(2026, 10, 1, 7, 59))).toBe(true) // 01:59 CST
    expect(ModelRouteSchedule.active(sunday, repeated)).toBe(false)
    // Normal week control: Sun 2026-11-08 01:30 CST is Saturday Nov 7's tail.
    expect(ModelRouteSchedule.active(saturday, Date.UTC(2026, 10, 8, 7, 30))).toBe(true)
  })

  test("a wrapping window's tail judges days of month on the previous day", () => {
    // Oct 31 2026 is the last day of October; its 22:00-02:00 window runs into Nov 1.
    const window = ModelRouteSchedule.parse({
      daysOfMonth: [-1],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    expect(ModelRouteSchedule.active(window, Date.UTC(2026, 10, 1, 7, 30))).toBe(true) // Nov 1 01:30 CST, repeated hour
    const first = ModelRouteSchedule.parse({
      daysOfMonth: [1],
      start: "22:00",
      end: "02:00",
      timezone: "America/Chicago",
    })!
    expect(ModelRouteSchedule.active(first, Date.UTC(2026, 10, 1, 7, 30))).toBe(false)
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
