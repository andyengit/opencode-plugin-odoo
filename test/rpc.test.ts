import { describe, expect, test } from "bun:test"
import { parseSavedConnections } from "../src/rpc"

describe("parseSavedConnections", () => {
  test("reads named connections with their credentials", () => {
    const text = JSON.stringify({
      prod: {
        url: "https://odoo.example.com",
        database: "produccion",
        username: "admin",
        password: "api-key",
      },
    })
    expect(parseSavedConnections(text)).toEqual({
      prod: {
        url: "https://odoo.example.com",
        database: "produccion",
        username: "admin",
        password: "api-key",
        enabled: true,
        writes: false,
      },
    })
  })

  test("respects the enable and write switches", () => {
    const text = JSON.stringify({
      prod: { url: "https://a", database: "d", username: "u", password: "p", enabled: false, writes: true },
    })
    expect(parseSavedConnections(text).prod).toMatchObject({ enabled: false, writes: true })
  })

  test("skips entries missing a field", () => {
    const text = JSON.stringify({
      ok: { url: "https://a", database: "d", username: "u", password: "p" },
      bad: { url: "https://b", database: "d" },
    })
    expect(Object.keys(parseSavedConnections(text))).toEqual(["ok"])
  })

  test("returns nothing for invalid or empty files", () => {
    expect(parseSavedConnections("not json")).toEqual({})
    expect(parseSavedConnections("")).toEqual({})
    expect(parseSavedConnections("[]")).toEqual({})
  })
})
