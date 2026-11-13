/** Helpers for rebuilding a local database from an adoo.live database pull. */

/** A safe Odoo database name for a rebuilt copy: `<environment>_<yyyymmdd>_<random>`. */
export function databaseName(label: string, date: Date, suffix = randomSuffix()): string {
  const ascii = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  const base =
    ascii
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "odoo"
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, "")
  const name = `${base}_${stamp}_${suffix}`
  return (/^[a-z]/.test(name) ? name : `db_${name}`).slice(0, 63)
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
