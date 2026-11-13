import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipInstall } from "../src/install"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "odoo-install-"))
})

afterAll(() => rm(root, { recursive: true, force: true }))

describe("pipInstall", () => {
  test("uses the virtualenv's own pip when it has one", async () => {
    const venv = join(root, "with-pip")
    await mkdir(join(venv, "bin"), { recursive: true })
    await writeFile(join(venv, "bin", "pip"), "")
    expect(await pipInstall(venv, ["-r", "requirements.txt"])).toEqual({
      file: join(venv, "bin", "pip"),
      args: ["install", "-r", "requirements.txt"],
    })
  })

  test("returns nothing for a folder that is not a virtualenv", async () => {
    expect(await pipInstall(join(root, "missing"), ["pandas"])).toBeUndefined()
  })
})
