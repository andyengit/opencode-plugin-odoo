/** Moves every cloned repository of a workspace to the latest commit of its branch. */

import { access, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { isAuthFailure, sshFallback } from "./clone"
import { runProcess } from "./execute"

export type RepoUpdateState = "updated" | "current" | "skipped" | "error"

export interface RepoUpdateResult {
  /** Path relative to the workspace root. */
  path: string
  branch: string
  state: RepoUpdateState
  message: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return runProcess("git", args, { cwd, timeoutMs: 600000 }).then(
    (result) => {
      if (result.code === 0) return undefined
      return result.output.trim().split("\n").slice(-3).join(" ").trim() || `git ${args[0]} failed`
    },
    (error) => String(error),
  )
}

function gitText(args: string[], cwd: string): Promise<string> {
  return runProcess("git", args, { cwd, timeoutMs: 600000 }).then(
    (result) => (result.code === 0 ? result.output.trim() : ""),
    () => "",
  )
}

/** Every clone the plugin manages: `custom` and `repo/<org>/<name>`. */
export async function repositoryDirectories(root: string): Promise<string[]> {
  const directories: string[] = []
  const custom = join(root, "custom")
  if (await exists(join(custom, ".git"))) directories.push(custom)
  const base = join(root, "repo")
  for (const org of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!org.isDirectory()) continue
    for (const entry of await readdir(join(base, org.name), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const directory = join(base, org.name, entry.name)
      if (await exists(join(directory, ".git"))) directories.push(directory)
    }
  }
  return directories.sort()
}

async function fetchAll(directory: string): Promise<string | undefined> {
  const failure = await git(["-C", directory, "fetch", "--all", "--prune"], directory)
  if (!failure || !isAuthFailure(failure)) return failure
  // HTTPS remotes that need credentials are switched to SSH, as the sync does.
  const origin = await gitText(["-C", directory, "remote", "get-url", "origin"], directory)
  const ssh = sshFallback(origin)
  if (!ssh) return failure
  const changed = await git(["-C", directory, "remote", "set-url", "origin", ssh], directory)
  if (changed) return changed
  return git(["-C", directory, "fetch", "--all", "--prune"], directory)
}

/**
 * Fetches each clone and fast-forwards to its upstream (or `origin/<branch>`). With `hard`, it
 * resets to that commit instead, discarding local changes.
 */
export async function updateRepositories(
  root: string,
  options: { hard?: boolean } = {},
): Promise<RepoUpdateResult[]> {
  const results: RepoUpdateResult[] = []
  for (const directory of await repositoryDirectories(root)) {
    const path = relative(root, directory)
    const branch = await gitText(["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], directory)
    if (branch === "" || branch === "HEAD") {
      results.push({ path, branch, state: "skipped", message: "Detached HEAD" })
      continue
    }
    const before = await gitText(["-C", directory, "rev-parse", "HEAD"], directory)
    const fetch = await fetchAll(directory)
    if (fetch) {
      results.push({ path, branch, state: "error", message: fetch })
      continue
    }
    const upstream = await gitText(
      ["-C", directory, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      directory,
    )
    const target = upstream !== "" ? upstream : `origin/${branch}`
    const commit = await gitText(["-C", directory, "rev-parse", "--verify", target], directory)
    if (commit === "") {
      results.push({ path, branch, state: "skipped", message: `No ${target} to follow` })
      continue
    }
    const failure = options.hard
      ? await git(["-C", directory, "reset", "--hard", commit], directory)
      : await git(["-C", directory, "merge", "--ff-only", commit], directory)
    if (failure) {
      results.push({ path, branch, state: "error", message: failure })
      continue
    }
    const after = await gitText(["-C", directory, "rev-parse", "HEAD"], directory)
    results.push({
      path,
      branch,
      state: before === after ? "current" : "updated",
      message: "",
    })
  }
  return results
}
