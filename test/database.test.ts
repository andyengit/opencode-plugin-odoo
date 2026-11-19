import { describe, expect, test } from "bun:test"
import { parseDatabases, parseModules, quoteIdentifier, safeDatabaseName } from "../src/database"

describe("parseDatabases", () => {
  test("reads name and size rows", () => {
    expect(parseDatabases("db\t34 MB\nproduccion_20261118_4821\t812 MB\n")).toEqual([
      { name: "db", size: "34 MB" },
      { name: "produccion_20261118_4821", size: "812 MB" },
    ])
  })

  test("accepts a bare name", () => {
    expect(parseDatabases("template1")).toEqual([{ name: "template1", size: "" }])
  })

  test("ignores blank lines", () => {
    expect(parseDatabases("\n \n")).toEqual([])
  })
})

describe("parseModules", () => {
  test("reads name, state and version", () => {
    expect(parseModules("base\tinstalled\t18.0.1.3\naccount\tuninstalled\t18.0.1.0\n")).toEqual([
      { name: "base", state: "installed", version: "18.0.1.3" },
      { name: "account", state: "uninstalled", version: "18.0.1.0" },
    ])
  })

  test("keeps rows without a version", () => {
    expect(parseModules("web\tinstalled")).toEqual([{ name: "web", state: "installed", version: "" }])
  })

  test("ignores blank lines", () => {
    expect(parseModules("")).toEqual([])
  })
})

describe("safeDatabaseName", () => {
  test("normalizes display names", () => {
    expect(safeDatabaseName("Producción 2026")).toBe("produccion_2026")
    expect(safeDatabaseName("2026 demo")).toBe("db_2026_demo")
    expect(safeDatabaseName("")).toBe("db_odoo")
  })

  test("keeps identifiers within 63 bytes", () => {
    expect(safeDatabaseName("a".repeat(100)).length).toBe(63)
  })
})

describe("quoteIdentifier", () => {
  test("wraps and escapes quotes", () => {
    expect(quoteIdentifier('mi"db')).toBe('"mi""db"')
  })
})
