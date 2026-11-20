import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspectRepositories, repositoryDirectories, updateRepositories } from "../src/reposUpdate"

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" })
const commit = (cwd: string, message: string) => {
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", "-A")
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message)
}

async function fixture(): Promise<{ root: string; origin: string; clone: string }> {
  const root = await mkdtemp(join(tmpdir(), "odoo-repos-update-"))
  const origin = join(root, "origin")
  await mkdir(origin)
  git(origin, "init", "-q", "-b", "main")
  await writeFile(join(origin, "a.txt"), "one\n")
  commit(origin, "first")
  const clone = join(root, "repo", "acme", "demo")
  await mkdir(join(root, "repo", "acme"), { recursive: true })
  git(root, "clone", "-q", origin, clone)
  return { root, origin, clone }
}

describe("repositoryDirectories", () => {
  test("lists repo/<org>/<name> and custom clones", async () => {
    const { root } = await fixture()
    const custom = join(root, "custom")
    await mkdir(custom)
    git(custom, "init", "-q")
    const directories = await repositoryDirectories(root)
    expect(directories).toContain(join(root, "repo", "acme", "demo"))
    expect(directories).toContain(custom)
    expect(directories).toHaveLength(2)
  })
})

describe("inspectRepositories", () => {
  test("lists only the repositories that are behind", async () => {
    const { root, origin } = await fixture()
    await writeFile(join(origin, "a.txt"), "two\n")
    commit(origin, "second")
    expect(await inspectRepositories(root)).toEqual([
      { path: "repo/acme/demo", branch: "main", state: "behind", ahead: 0, behind: 1, message: "" },
    ])
    await updateRepositories(root)
    expect((await inspectRepositories(root))[0]?.state).toBe("current")
  })

  test("reports divergence with both counters", async () => {
    const { root, origin, clone } = await fixture()
    await writeFile(join(clone, "local.txt"), "local\n")
    commit(clone, "local")
    await writeFile(join(origin, "remote.txt"), "remote\n")
    commit(origin, "remote")
    const status = (await inspectRepositories(root))[0]
    expect(status?.state).toBe("diverged")
    expect(status?.ahead).toBe(1)
    expect(status?.behind).toBe(1)
  })
})

describe("updateRepositories", () => {
  test("fast-forwards to the latest commit and then reports it is current", async () => {
    const { root, origin, clone } = await fixture()
    await writeFile(join(origin, "a.txt"), "two\n")
    commit(origin, "second")

    const first = await updateRepositories(root)
    expect(first).toEqual([{ path: "repo/acme/demo", branch: "main", state: "updated", message: "" }])
    expect(execFileSync("git", ["-C", clone, "show", "HEAD:a.txt"], { encoding: "utf8" })).toBe("two\n")

    const second = await updateRepositories(root)
    expect(second[0]?.state).toBe("current")
  })

  test("fails on divergence unless hard reset is requested", async () => {
    const { root, origin, clone } = await fixture()
    await writeFile(join(clone, "local.txt"), "local\n")
    commit(clone, "local")
    await writeFile(join(origin, "remote.txt"), "remote\n")
    commit(origin, "remote")

    const safe = await updateRepositories(root)
    expect(safe[0]?.state).toBe("error")
    expect(safe[0]?.message).toContain("fast-forward")

    const hard = await updateRepositories(root, { hard: true })
    expect(hard[0]?.state).toBe("updated")
    expect(execFileSync("git", ["-C", clone, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim()).toBe("remote")
  })

  test("limits the work to the given repository paths", async () => {
    const { root, origin } = await fixture()
    await writeFile(join(origin, "a.txt"), "two\n")
    commit(origin, "second")
    expect(await updateRepositories(root, { paths: ["repo/other/repo"] })).toEqual([])
    const results = await updateRepositories(root, { paths: ["repo/acme/demo"] })
    expect(results.map((result) => result.path)).toEqual(["repo/acme/demo"])
  })
})
