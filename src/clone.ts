/** Clones a repository from any git host into the workspace's `repo/<org>/<name>` layout. */

import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { getAddonsPath, parseOdooConfig, setAddonsPathText } from "./config"
import { runProcess } from "./execute"
import { repoFolder, sshUrl } from "./repos"

export interface CloneRequest {
  url: string
  branch?: string
  ssh?: boolean
}

export interface CloneResult {
  ok: boolean
  message: string
  relative: string
  path: string
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Accepts full URLs, scp-like SSH URLs and the `org/repo` shorthand (GitHub by default). */
export function normalizeRepoUrl(input: string, ssh = false): string {
  const trimmed = input.trim()
  if (trimmed === "") return ""
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  const scp = /^[^@/\s]+@[^:/\s]+:/.test(trimmed)
  const absolute = trimmed.startsWith("/") || trimmed.startsWith("~")
  const url = hasScheme || scp || absolute ? trimmed : `https://github.com/${trimmed.replace(/^\/+/, "")}`
  return ssh ? (sshUrl(url) ?? url) : url
}

async function git(args: string[], cwd: string): Promise<string | undefined> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 600000 })
  if (result.code === 0) return undefined
  return result.output.trim().split("\n").slice(-4).join(" ").trim() || `git ${args[0]} failed`
}

/** Whether a git failure means the HTTPS remote asked for credentials that git cannot prompt for. */
export function isAuthFailure(message: string): boolean {
  return /could not read Username|Authentication failed|terminal prompts disabled|Repository not found|Permission denied \(publickey\)/i.test(
    message,
  )
}

/** The SSH form of an HTTPS repository URL, when it differs. */
export function sshFallback(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url)) return undefined
  const ssh = sshUrl(url)
  return ssh === undefined || ssh === url ? undefined : ssh
}

export async function cloneRepository(root: string, request: CloneRequest): Promise<CloneResult> {
  const url = normalizeRepoUrl(request.url, request.ssh ?? false)
  if (url === "") return { ok: false, message: "Write the repository URL", relative: "", path: "" }
  const folder = repoFolder(root, url)
  if (!folder)
    return { ok: false, message: "Write a git URL like https://github.com/org/repo", relative: "", path: "" }
  const path = resolve(folder.path)
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`))
    return { ok: false, message: "That repository name is not allowed", relative: "", path: "" }
  const branch = (request.branch ?? "").trim()
  const failure = async (message: string): Promise<CloneResult> => ({
    ok: false,
    message,
    relative: folder.relative,
    path,
  })

  if (await exists(path)) {
    const fetch = await git(["fetch", "--all", "--prune"], path)
    if (fetch) return failure(fetch)
    if (branch !== "") {
      const checkout = await git(["checkout", branch], path)
      if (checkout) return failure(checkout)
    }
    const pull = await git(["pull", "--ff-only"], path)
    if (pull) return failure(pull)
    return { ok: true, message: `Updated ${folder.relative}`, relative: folder.relative, path }
  }

  await mkdir(dirname(path), { recursive: true })
  const attempt = (target: string) => {
    const args = branch === "" ? ["clone", target, path] : ["clone", "--branch", branch, target, path]
    return git(args, root)
  }
  let clone = await attempt(url)
  let overSsh = false
  if (clone) {
    // A private repository cloned over HTTPS cannot prompt for credentials here; retry with SSH.
    const fallback = sshFallback(url)
    if (fallback && isAuthFailure(clone)) {
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
      await mkdir(dirname(path), { recursive: true })
      clone = await attempt(fallback)
      overSsh = clone === undefined
    }
  }
  if (clone) {
    await rm(path, { recursive: true, force: true }).catch(() => undefined)
    return failure(clone)
  }
  return {
    ok: true,
    message: `Cloned ${folder.relative}${overSsh ? " over SSH" : ""}`,
    relative: folder.relative,
    path,
  }
}

/** Adds a cloned repository to the active configuration's addons_path when it is not there yet. */
export async function addFolderToAddons(confPath: string, folder: string): Promise<void> {
  const text = await readFile(confPath, "utf8").catch(() => "")
  const current = getAddonsPath(parseOdooConfig(text))
  if (current.includes(folder)) return
  await writeFile(confPath, setAddonsPathText(text, [...current, folder]))
}
