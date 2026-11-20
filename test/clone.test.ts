import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloneRepository, isAuthFailure, normalizeRepoUrl, sshFallback } from "../src/clone"

describe("normalizeRepoUrl", () => {
  test("accepts full URLs, scp URLs and the org/repo shorthand", () => {
    expect(normalizeRepoUrl("https://github.com/oca/server-tools")).toBe("https://github.com/oca/server-tools")
    expect(normalizeRepoUrl("git@github.com:oca/server-tools.git")).toBe("git@github.com:oca/server-tools.git")
    expect(normalizeRepoUrl("oca/server-tools")).toBe("https://github.com/oca/server-tools")
  })

  test("converts to SSH on request", () => {
    expect(normalizeRepoUrl("https://gitlab.com/org/repo.git", true)).toBe("git@gitlab.com:org/repo.git")
    expect(normalizeRepoUrl("org/repo", true)).toBe("git@github.com:org/repo.git")
  })

  test("returns nothing for an empty value", () => {
    expect(normalizeRepoUrl("   ")).toBe("")
  })
})

describe("SSH fallback", () => {
  test("recognizes credential failures", () => {
    expect(isAuthFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(
      true,
    )
    expect(isAuthFailure("remote: Repository not found.")).toBe(true)
    expect(isAuthFailure("fatal: destination path already exists")).toBe(false)
  })

  test("only converts HTTPS URLs", () => {
    expect(sshFallback("https://github.com/poweredbyandy/vertical-sale.git")).toBe(
      "git@github.com:poweredbyandy/vertical-sale.git",
    )
    expect(sshFallback("git@github.com:poweredbyandy/vertical-sale.git")).toBeUndefined()
  })
})

describe("cloneRepository", () => {
  test("clones a repository and updates it later", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-clone-"))
    const origin = join(root, "origin")
    await mkdir(origin)
    execSync(`git init -q`, { cwd: origin })
    await writeFile(join(origin, "addons.py"), "one\n")
    execSync(`git -c user.name=t -c user.email=t@example.com add -A`, { cwd: origin })
    execSync(`git -c user.name=t -c user.email=t@example.com commit -qm first`, { cwd: origin })

    const workspace = join(root, "workspace")
    await mkdir(workspace)
    const first = await cloneRepository(workspace, { url: origin })
    expect(first.ok).toBe(true)
    expect(first.message).toContain("Cloned")
    expect(await readFile(join(first.path, "addons.py"), "utf8")).toBe("one\n")

    await writeFile(join(origin, "addons.py"), "two\n")
    execSync(`git -c user.name=t -c user.email=t@example.com commit -qam second`, { cwd: origin })
    const second = await cloneRepository(workspace, { url: origin })
    expect(second.ok).toBe(true)
    expect(second.message).toContain("Updated")
    expect(await readFile(join(second.path, "addons.py"), "utf8")).toBe("two\n")
  })

  test("clones a branch when one is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-clone-branch-"))
    const origin = join(root, "origin")
    await mkdir(origin)
    execSync(`git init -q`, { cwd: origin })
    await writeFile(join(origin, "a.txt"), "main\n")
    execSync(`git -c user.name=t -c user.email=t@example.com add -A`, { cwd: origin })
    execSync(`git -c user.name=t -c user.email=t@example.com commit -qm first`, { cwd: origin })
    execSync(`git -c user.name=t -c user.email=t@example.com checkout -qb 18.0`, { cwd: origin })
    await writeFile(join(origin, "a.txt"), "branch\n")
    execSync(`git -c user.name=t -c user.email=t@example.com commit -qam branch`, { cwd: origin })

    const workspace = join(root, "workspace")
    await mkdir(workspace)
    const result = await cloneRepository(workspace, { url: origin, branch: "18.0" })
    expect(result.ok).toBe(true)
    expect(await readFile(join(result.path, "a.txt"), "utf8")).toBe("branch\n")
  })

  test("rejects an empty URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-clone-empty-"))
    const result = await cloneRepository(root, { url: " " })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("URL")
  })
})
