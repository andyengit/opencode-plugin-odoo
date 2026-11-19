import { describe, expect, test } from "bun:test"
import { LOG_AMBER, LOG_CYAN, LOG_DIM, LOG_GRAY, LOG_GREEN, LOG_RED, logSegments } from "../src/logs"

const INFO_LINE = "2026-11-19 03:18:32,511 98128 INFO db odoo.modules.loading: loading 1 modules..."
const ERROR_LINE = "2026-11-19 03:18:32,511 98128 ERROR db odoo.http: Something failed"
const WARNING_LINE = "2026-11-19 03:18:32,511 98128 WARNING ? odoo.addons.base: careful"

function joined(line: string) {
  return logSegments(line)
    .map((segment) => segment.text)
    .join("")
}

describe("logSegments", () => {
  test("keeps the line intact while splitting the prefix", () => {
    expect(joined(INFO_LINE)).toBe(INFO_LINE)
  })

  test("colors timestamp, pid, level and logger", () => {
    const segments = logSegments(INFO_LINE)
    expect(segments[0]).toEqual({ text: "2026-11-19 03:18:32,511", color: LOG_GRAY })
    expect(segments[1]).toEqual({ text: " 98128 ", color: LOG_DIM })
    expect(segments[2]).toEqual({ text: "INFO", color: LOG_GREEN, bold: true })
    expect(segments[3]).toEqual({ text: " db ", color: LOG_GRAY })
    expect(segments[4]).toEqual({ text: "odoo.modules.loading:", color: LOG_CYAN })
    expect(segments[5]).toEqual({ text: " loading 1 modules..." })
  })

  test("colors warnings and errors differently", () => {
    expect(logSegments(WARNING_LINE)[2]?.color).toBe(LOG_AMBER)
    expect(logSegments(ERROR_LINE)[2]?.color).toBe(LOG_RED)
  })

  test("colors keywords inside the message", () => {
    const segments = logSegments(`${INFO_LINE} retrying after ERROR`)
    expect(segments.some((segment) => segment.text === "ERROR" && segment.color === LOG_RED)).toBe(true)
  })

  test("paints traceback frames red", () => {
    const frame = '  File "/Users/andy/x.py", line 3, in method'
    expect(logSegments(frame)).toEqual([{ text: frame, color: LOG_RED }])
    expect(logSegments("Traceback (most recent call last):")).toEqual([
      { text: "Traceback (most recent call last):", color: LOG_RED },
    ])
  })

  test("handles lines without the Odoo prefix", () => {
    expect(joined("Exception in thread odoo.service.cron.cron0:")).toBe(
      "Exception in thread odoo.service.cron.cron0:",
    )
    expect(logSegments("plain message")).toEqual([{ text: "plain message" }])
  })
})
