/** Checks and moves the cloned repositories of a workspace to the latest commit of their branch. */

import { access, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { parseAheadBehind } from "./git"
import { isAuthFailure, sshFallback } from "./clone"
import { runProcess } from "./execute"

export type RepoUpdateState = "updated" | "current" | "skipped" | "error"
export type RepoStatusState = "current" | "behind" | "diverged" | "skipped" | "error"

export interface RepoUpdateResult {
  /** Path relative to the workspace root. */
  path: string
  branch: string
  state: RepoUpdateState
  message: string
}

export interface RepoStatus {
  /** Path relative to the workspace root. */
  path: string
  branch: string
  state: RepoStatusState
  /** Commits the local branch has that the target does not. */
  ahead: number
  /** Commits the target has that the local branch does not. */
  behind: number
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

/** Runs `fn` over `items` with at most `limit` at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const current = index++
      if (current >= items.length) return
      results[current] = await fn(items[current] as T)
    }
  })
  await Promise.all(workers)
  return results
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

async function targetOf(directory: string, branch: string): Promise<string> {
  const upstream = await gitText(
    ["-C", directory, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    directory,
  )
  return upstream !== "" ? upstream : `origin/${branch}`
}

async function inspectRepository(root: string, directory: string): Promise<RepoStatus> {
  const path = relative(root, directory)
  const branch = await gitText(["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], directory)
  if (branch === "" || branch === "HEAD") {
    return { path, branch, state: "skipped", ahead: 0, behind: 0, message: "Detached HEAD" }
  }
  const fetch = await fetchAll(directory)
  if (fetch) return { path, branch, state: "error", ahead: 0, behind: 0, message: fetch }
  const target = await targetOf(directory, branch)
  const commit = await gitText(["-C", directory, "rev-parse", "--verify", target], directory)
  if (commit === "") {
    return { path, branch, state: "skipped", ahead: 0, behind: 0, message: `No ${target} to follow` }
  }
  const counts = parseAheadBehind(
    await gitText(["-C", directory, "rev-list", "--left-right", "--count", `HEAD...${commit}`], directory),
  )
  const state = counts.behind === 0 ? "current" : counts.ahead > 0 ? "diverged" : "behind"
  return { path, branch, state, ahead: counts.ahead, behind: counts.behind, message: "" }
}

/** Fetches every clone and reports which ones are not at the latest commit of their branch. */
export async function inspectRepositories(root: string): Promise<RepoStatus[]> {
  const directories = await repositoryDirectories(root)
  return mapLimit(directories, 4, (directory) => inspectRepository(root, directory))
}

async function updateRepository(
  root: string,
  directory: string,
  options: { hard?: boolean },
): Promise<RepoUpdateResult> {
  const path = relative(root, directory)
  const branch = await gitText(["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], directory)
  if (branch === "" || branch === "HEAD") {
    return { path, branch, state: "skipped", message: "Detached HEAD" }
  }
  const before = await gitText(["-C", directory, "rev-parse", "HEAD"], directory)
  const fetch = await fetchAll(directory)
  if (fetch) return { path, branch, state: "error", message: fetch }
  const target = await targetOf(directory, branch)
  const commit = await gitText(["-C", directory, "rev-parse", "--verify", target], directory)
  if (commit === "") {
    return { path, branch, state: "skipped", message: `No ${target} to follow` }
  }
  const failure = options.hard
    ? await git(["-C", directory, "reset", "--hard", commit], directory)
    : await git(["-C", directory, "merge", "--ff-only", commit], directory)
  if (failure) return { path, branch, state: "error", message: failure }
  const after = await gitText(["-C", directory, "rev-parse", "HEAD"], directory)
  return { path, branch, state: before === after ? "current" : "updated", message: "" }
}

/**
 * Fetches each clone and fast-forwards to its upstream (or `origin/<branch>`). With `hard`, it
 * resets to that commit instead, discarding local changes. `paths` limits the work to those
 * workspace-relative repositories.
 */
export async function updateRepositories(
  root: string,
  options: { hard?: boolean; paths?: readonly string[] } = {},
): Promise<RepoUpdateResult[]> {
  const wanted = options.paths && options.paths.length > 0 ? new Set(options.paths) : undefined
  const results: RepoUpdateResult[] = []
  for (const directory of await repositoryDirectories(root)) {
    if (wanted && !wanted.has(relative(root, directory))) continue
    results.push(await updateRepository(root, directory, options))
  }
  return results
}
