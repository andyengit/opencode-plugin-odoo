import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isProcessRunning, runningPid } from "../src/process"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "odoo-process-"))
})

afterAll(() => rm(root, { recursive: true, force: true }))

describe("runningPid", () => {
  test("reads the pid of a live process", async () => {
    const file = join(root, "live.pid")
    await writeFile(file, String(process.pid))
    expect(await runningPid(file)).toBe(process.pid)
    expect(await isProcessRunning(file)).toBe(true)
  })

  test("ignores a pid that is not running", async () => {
    const file = join(root, "dead.pid")
    await writeFile(file, "999999")
    expect(await runningPid(file)).toBe(0)
    expect(await isProcessRunning(file)).toBe(false)
  })

  test("returns zero without a pid file", async () => {
    expect(await runningPid(join(root, "missing.pid"))).toBe(0)
  })

  test("returns zero for an empty file", async () => {
    const file = join(root, "empty.pid")
    await writeFile(file, "")
    expect(await runningPid(file)).toBe(0)
  })
})
