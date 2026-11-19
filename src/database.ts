/** Helpers for the local Postgres databases of a workspace. */

export interface DatabaseInfo {
  name: string
  size: string
}

export interface ModuleInfo {
  name: string
  state: string
  version: string
}

/** Reads `psql -At -F '\t'` rows of `datname\tpg_size_pretty(...)`. */
export function parseDatabases(output: string): DatabaseInfo[] {
  return output.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === "") return []
    const tab = trimmed.indexOf("\t")
    if (tab === -1) return [{ name: trimmed, size: "" }]
    return [{ name: trimmed.slice(0, tab), size: trimmed.slice(tab + 1) }]
  })
}

/** Reads `psql -At -F '\t'` rows of `name\tstate\tlatest_version`. */
export function parseModules(output: string): ModuleInfo[] {
  return output.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (trimmed === "") return []
    const [name = "", state = "", version = ""] = trimmed.split("\t")
    if (name === "") return []
    return [{ name, state, version }]
  })
}

/** A safe database name: lowercase, letters, digits and underscores, at most 63 bytes. */
export function safeDatabaseName(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  const value = /^[a-z]/.test(base) ? base : `db_${base || "odoo"}`
  return value.slice(0, 63)
}

/** Quotes an identifier for `CREATE DATABASE`, doubling inner quotes. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}
