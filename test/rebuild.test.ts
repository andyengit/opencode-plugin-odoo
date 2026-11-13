import { describe, expect, test } from "bun:test"
import { databaseName, parsePull, pullFailed, pullReady } from "../src/rebuild"

const day = new Date("2026-11-12T08:00:00Z")

describe("databaseName", () => {
  test("joins the environment and the backup date", () => {
    expect(databaseName("Acme Prod", day, "4821")).toBe("acme_prod_20261112_4821")
  })

  test("drops accents", () => {
    expect(databaseName("Producción PBA", day, "0420")).toBe("produccion_pba_20261112_0420")
  })

  test("prefixes a name that does not start with a letter", () => {
    expect(databaseName("2026 demo", day, "9999")).toBe("db_2026_demo_20261112_9999")
  })

  test("falls back to odoo for an empty label", () => {
    expect(databaseName("", day, "1234")).toBe("odoo_20261112_1234")
  })
})

describe("parsePull", () => {
  test("reads the pull fields", () => {
    expect(parsePull({ id: "p1", status: "pending", download_path: "" })).toEqual({
      id: "p1",
      status: "pending",
      downloadPath: "",
    })
  })

  test("reads a nested pull", () => {
    expect(parsePull({ pull: { id: 7, status: "success", download_path: "/x" } })).toEqual({
      id: "7",
      status: "success",
      downloadPath: "/x",
    })
  })

  test("returns nothing without an id", () => {
    expect(parsePull({ status: "pending" })).toBeUndefined()
  })
})

describe("pull status", () => {
  test("is ready only with success and a path", () => {
    expect(pullReady({ id: "p", status: "success", downloadPath: "/file" })).toBe(true)
    expect(pullReady({ id: "p", status: "success", downloadPath: "" })).toBe(false)
    expect(pullReady({ id: "p", status: "pending", downloadPath: "" })).toBe(false)
    expect(pullReady(undefined)).toBe(false)
  })

  test("knows the failure states", () => {
    expect(pullFailed("failed")).toBe(true)
    expect(pullFailed("expired")).toBe(true)
    expect(pullFailed("pending")).toBe(false)
    expect(pullFailed("success")).toBe(false)
  })
})
