import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseVersionMap, readVersionMap, removeVersion, writeVersion } from "../src/versions"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "odoo-versions-"))
})

afterAll(() => rm(root, { recursive: true, force: true }))

describe("parseVersionMap", () => {
  test("keeps string entries", () => {
    expect(parseVersionMap('{"odoo":"odoo18","demo":"odoo17"}')).toEqual({ odoo: "odoo18", demo: "odoo17" })
  })

  test("ignores invalid JSON and non-object values", () => {
    expect(parseVersionMap("not json")).toEqual({})
    expect(parseVersionMap("[]")).toEqual({})
    expect(parseVersionMap('{"odoo":1}')).toEqual({})
  })
})

describe("version files", () => {
  test("writes and reads back the chosen version per configuration", async () => {
    await writeVersion(root, "odoo", "odoo18")
    await writeVersion(root, "demo", "odoo17")
    expect(await readVersionMap(root)).toEqual({ odoo: "odoo18", demo: "odoo17" })
  })

  test("removes a configuration entry", async () => {
    await removeVersion(root, "demo")
    expect(await readVersionMap(root)).toEqual({ odoo: "odoo18" })
  })

  test("removes everything once the last configuration is gone", async () => {
    await removeVersion(root, "odoo")
    expect(await readVersionMap(root)).toEqual({})
  })
})
