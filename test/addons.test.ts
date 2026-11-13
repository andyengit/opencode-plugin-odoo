import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { availableAddons } from "../src/addons"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "odoo-addons-"))
  await mkdir(join(root, "custom"), { recursive: true })
  await mkdir(join(root, "repo", "oca", "server-tools"), { recursive: true })
  await mkdir(join(root, "repo", "poweredbyandy", "payroll"), { recursive: true })
  await mkdir(join(root, "bin", "odoo-18"), { recursive: true })
})

afterAll(() => rm(root, { recursive: true, force: true }))

describe("availableAddons", () => {
  test("lists custom and every cloned repository", async () => {
    expect(await availableAddons(root)).toEqual([
      join(root, "custom"),
      join(root, "repo", "oca", "server-tools"),
      join(root, "repo", "poweredbyandy", "payroll"),
    ])
  })
})
