/** Helpers for rebuilding a local database from an adoo.live database pull. */

/** A safe Odoo database name for a rebuilt copy: `<project url>_<yyyymmdd>_<random>`. */
export function databaseName(label: string, date: Date, suffix = randomSuffix()): string {
  // The rebuild names the copy after the project's site, so a URL keeps its host and drops the scheme and path.
  const trimmed = label.trim().replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "")
  const ascii = trimmed.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  const sanitized =
    ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "odoo"
  const base = /^[a-z]/.test(sanitized) ? sanitized : `db_${sanitized}`
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, "")
  // Postgres limits an identifier to 63 bytes; trim the host so the date and the random suffix always survive.
  const tail = `_${stamp}_${suffix}`
  return `${base.slice(0, 63 - tail.length)}${tail}`
}

function randomSuffix(): string {
  return String(1000 + Math.floor(Math.random() * 9000))
}

export interface DatabasePull {
  id: string
  status: string
  downloadPath: string
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : ""
}

/** Reads the pull a create or status call returns. */
export function parsePull(body: unknown): DatabasePull | undefined {
  const outer = record(body)
  const entry = outer.pull ? record(outer.pull) : outer
  const id = text(entry.id)
  if (id === "") return
  return { id, status: text(entry.status), downloadPath: text(entry.download_path) }
}

/** The server finished and the file is still downloadable. */
export function pullReady(pull: DatabasePull | undefined): boolean {
  return !!pull && pull.status === "success" && pull.downloadPath !== ""
}

export function pullFailed(status: string): boolean {
  return ["failed", "error", "expired", "canceled", "cancelled", "purged"].includes(status)
}
