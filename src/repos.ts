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
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const list = Array.isArray(record.addon_repos) ? record.addon_repos : Array.isArray(body) ? body : []
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const item = entry as Record<string, unknown>
    const url = typeof item.url === "string" ? item.url.trim() : ""
    if (url === "") return []
    const declared = typeof item.name === "string" ? item.name.trim() : ""
    const name = declared !== "" ? declared : (repoLocation(url)?.name ?? "")
    const branch = typeof item.branch === "string" ? item.branch.trim() : ""
    const auth = typeof item.git_auth_mode === "string" && item.git_auth_mode !== "" ? item.git_auth_mode : "public"
    return [{ name, url, branch, auth }]
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
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  const list = Array.isArray(record.unified_repos)
    ? record.unified_repos
    : Array.isArray(record.repos)
      ? record.repos
      : []
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const item = entry as Record<string, unknown>
    const url = typeof item.url === "string" ? item.url.trim() : ""
    if (url === "") return []
    const declared = typeof item.name === "string" ? item.name.trim() : ""
    return [
      {
        name: declared !== "" ? declared : (repoLocation(url)?.name ?? ""),
        url,
        branch: typeof item.branch === "string" ? item.branch.trim() : "",
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
