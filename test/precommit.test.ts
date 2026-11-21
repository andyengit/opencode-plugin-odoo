import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { preCommitInfo, runPreCommit, setupPreCommit, stagedDigest } from "../src/precommit"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" })

describe("preCommitInfo", () => {
  test("detects the OCA hooks in the config", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-precommit-"))
    await writeFile(join(root, ".pre-commit-config.yaml"), "repos:\n  - repo: https://github.com/OCA/odoo-pre-commit-hooks\n")
    const info = await preCommitInfo(root)
    expect(info.configured).toBe(true)
    expect(info.oca).toBe(true)
  })

  test("reports a repository without a config", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-precommit-none-"))
    await expect(preCommitInfo(root)).resolves.toMatchObject({ configured: false, oca: false })
  })
})

describe("setupPreCommit", () => {
  test("creates the OCA config once", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-precommit-setup-"))
    expect(await setupPreCommit(root)).toContain("Created")
    const text = await readFile(join(root, ".pre-commit-config.yaml"), "utf8")
    expect(text).toContain("OCA/odoo-pre-commit-hooks")
    expect(text).toContain("oca-checks-odoo-module")
    expect(await setupPreCommit(root)).toContain("already has")
  })
})

describe("runPreCommit", () => {
  test("reports a missing config before trying a runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-precommit-missing-"))
    const result = await runPreCommit(root)
    expect(result.state).toBe("missing")
    expect(result.output).toContain(".pre-commit-config.yaml")
  })
})

describe("stagedDigest", () => {
  test("changes when the staged content changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-precommit-digest-"))
    git(root, "init", "-q", "-b", "main")
    await mkdir(join(root, "models"))
    await writeFile(join(root, "models", "a.py"), "one\n")
    git(root, "add", ".")
    const first = await stagedDigest(root)
    expect(first).not.toBe("")
    await writeFile(join(root, "models", "a.py"), "two\n")
    git(root, "add", ".")
    expect(await stagedDigest(root)).not.toBe(first)
  })
})
