import { join } from "node:path"

/** A repository an adoo.live stack deploys, as the stack detail lists it. */
export interface StackRepo {
  name: string
  url: string
  branch: string
  /** `public` or `deploy_key`: private repositories need the machine's SSH key. */
  auth: string
}

export function parseStackRepos(body: unknown): StackRepo[] {
  return listOf(body).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const item = entry as Record<string, unknown>
    const url = urlOf(item)
    if (url === "") return []
    const declared = typeof item.name === "string" ? item.name.trim() : ""
    const name = declared !== "" ? declared : (repoLocation(url)?.name ?? "")
    return [{ name, url, branch: branchOf(item), auth: authOf(item) }]
  })
}

/** The array of repositories of a stack or environment detail, under any of the names adoo uses. */
function listOf(body: unknown, depth = 0): unknown[] {
  if (Array.isArray(body)) return body
  if (depth > 2 || typeof body !== "object" || body === null) return []
  const record = body as Record<string, unknown>
  for (const key of ["addon_repos", "unified_repos", "repos", "repositories", "git_repos"]) {
    if (Array.isArray(record[key])) return record[key]
  }
  // Some payloads nest the stack or the environment under its own key.
  for (const key of ["stack", "environment", "settings", "git"]) {
    const nested = record[key]
    if (typeof nested === "object" && nested !== null) {
      const found = listOf(nested, depth + 1)
      if (found.length > 0) return found
    }
  }
  return []
}

function urlOf(item: Record<string, unknown>): string {
  for (const key of ["url", "git_url", "repo_url", "repository_url", "clone_url", "repository"]) {
    const value = item[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return ""
}

function branchOf(item: Record<string, unknown>): string {
  for (const key of ["branch", "git_branch", "target_branch", "ref"]) {
    const value = item[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  return ""
}

function authOf(item: Record<string, unknown>): string {
  for (const key of ["git_auth_mode", "auth", "git_auth"]) {
    const value = item[key]
    if (typeof value === "string" && value !== "") return value
  }
  return "public"
}

/** A case-insensitive repository identity, ignoring a trailing `.git` and slashes. */
export function repoKey(url: string): string {
  return url.trim().replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase()
}

/**
 * The repositories to sync: the stack's plus the ones the environment adds, without duplicates.
 * An environment can own repositories that are not part of its stack.
 */
export function mergeRepos(stackBody: unknown, environmentBody?: unknown): StackRepo[] {
  const environment =
    environmentBody === undefined
      ? []
      : parseEnvironmentRepos(environmentBody).map((repo) => ({
          name: repo.name,
          url: repo.url,
          branch: repo.branch,
          auth: "public",
        }))
  const seen = new Set<string>()
  return [...parseStackRepos(stackBody), ...environment].filter((repo) => {
    const key = repoKey(repo.url)
    if (key === "" || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

interface RepoParts {
  host: string
  org: string
  name: string
}

function repoParts(url: string): RepoParts | undefined {
  const trimmed = url.trim()
  if (trimmed === "") return
  const clean = trimmed.split("?")[0]?.split("#")[0] ?? trimmed
  const scp = /^[^@/]+@([^/:]+):(.+)$/.exec(clean)
  const rest = scp ? `${scp[1]}/${scp[2]}` : clean.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "")
  const parts = rest.split("/").filter((part) => part !== "")
  const path = parts.length >= 3 ? parts.slice(1) : parts
  if (path.length < 2) return
  const host = parts[0] ?? ""
  const org = path[0] ?? ""
  const name = (path[path.length - 1] ?? "").replace(/\.git$/, "")
  if (host === "" || org === "" || name === "") return
  return { host, org, name }
}

/** The organization and repository name of a git URL, from HTTPS, SSH or scp-like forms. */
export function repoLocation(url: string): { org: string; name: string } | undefined {
  const parts = repoParts(url)
  if (!parts) return
  return { org: parts.org.toLowerCase(), name: parts.name }
}

/** The scp-like SSH URL of a repository, for private clones that use the machine's SSH key. */
export function sshUrl(url: string): string | undefined {
  const parts = repoParts(url)
  if (!parts) return
  return `git@${parts.host}:${parts.org}/${parts.name}.git`
}

/** Where a repository is cloned: `repo/<organization>/<name>` under the workspace root. */
export function repoFolder(root: string, url: string): { path: string; relative: string } | undefined {
  const location = repoLocation(url)
  if (!location) return
  const relative = join("repo", location.org, location.name)
  return { path: join(root, relative), relative }
}

/** A repository of an adoo.live environment, with the commit adoo.live deploys. */
export interface EnvironmentRepo {
  name: string
  url: string
  branch: string
  commit: string
}

export function parseEnvironmentRepos(body: unknown): EnvironmentRepo[] {
  return listOf(body).flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const item = entry as Record<string, unknown>
    const url = urlOf(item)
    if (url === "") return []
    const declared = typeof item.name === "string" ? item.name.trim() : ""
    return [
      {
        name: declared !== "" ? declared : (repoLocation(url)?.name ?? ""),
        url,
        branch: branchOf(item),
        commit:
          (typeof item.configured_commit === "string" ? item.configured_commit.trim() : "") ||
          (typeof item.commit === "string" ? item.commit.trim() : ""),
      },
    ]
  })
}

/** Whether a local commit matches the one adoo.live configured, comparing abbreviated hashes too. */
export function sameCommit(configured: string, local: string): boolean {
  const wanted = configured.trim().toLowerCase()
  const found = local.trim().toLowerCase()
  if (wanted === "" || found === "") return false
  const length = Math.min(wanted.length, found.length)
  if (length < 7) return false
  return wanted.slice(0, length) === found.slice(0, length)
}
