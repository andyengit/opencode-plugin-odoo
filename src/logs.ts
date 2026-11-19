/** Colorizes the common words of an Odoo log line. Keep this module free of UI imports so it is testable. */

export interface LogSegment {
  text: string
  color?: string
  bold?: boolean
}

export const LOG_RED = "#f87171"
export const LOG_AMBER = "#fbbf24"
export const LOG_GREEN = "#34d399"
export const LOG_CYAN = "#67e8f9"
export const LOG_GRAY = "#9ca3af"
export const LOG_DIM = "#6b7280"
export const LOG_TEXT = "#e5e7eb"

/** `2026-11-19 03:18:32,511 98128 INFO db odoo.modules.loading: loading 1 modules...` */
const PREFIX = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+)( +)(\d+)( +)([A-Z]+)( +)(\S+)( +)([^\s:]+)(:?)(.*)$/
const WORDS = /(ERROR|CRITICAL|WARNING|INFO|DEBUG|Traceback|Exception|Error)/g

function levelColor(level: string): string {
  if (level === "ERROR" || level === "CRITICAL") return LOG_RED
  if (level === "WARNING") return LOG_AMBER
  if (level === "INFO") return LOG_GREEN
  if (level === "DEBUG") return LOG_DIM
  return LOG_TEXT
}

function wordColor(word: string): string {
  if (word === "WARNING") return LOG_AMBER
  if (word === "INFO") return LOG_GREEN
  if (word === "DEBUG") return LOG_DIM
  return LOG_RED
}

function words(text: string): LogSegment[] {
  return text.split(WORDS).flatMap((part, index) => {
    if (part === "") return []
    return [{ text: part, color: index % 2 === 1 ? wordColor(part) : undefined }]
  })
}

/** Splits one log line into colored pieces: timestamp, pid, level, logger and message keywords. */
export function logSegments(line: string): LogSegment[] {
  const match = PREFIX.exec(line)
  if (!match) {
    // Traceback frames are the most common lines without a prefix.
    if (/^\s+File "/.test(line) || /^(Traceback|Exception)/.test(line)) return [{ text: line, color: LOG_RED }]
    return words(line)
  }
  const [, stamp, gap1, pid, gap2, level, gap3, database, gap4, logger, colon, message] = match
  return [
    { text: stamp, color: LOG_GRAY },
    { text: gap1 + pid + gap2, color: LOG_DIM },
    { text: level, color: levelColor(level), bold: true },
    { text: gap3 + database + gap4, color: LOG_GRAY },
    { text: logger + colon, color: LOG_CYAN },
    ...words(message),
  ]
}
