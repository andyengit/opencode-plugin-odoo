/** Git output parsers shared by the panel and the agent tools. */

export interface GitFile {
  /** Path inside the repository. */
  path: string
  /** The two status letters, trimmed (`M`, `A`, `D`, `R`, `??`, ...). */
  code: string
  /** The index holds changes for this file. */
  staged: boolean
  /** The working tree holds changes for this file. */
  worktree: boolean
  /** The file is not tracked yet. */
  untracked: boolean
}

export interface GitStash {
  /** Position in `git stash list`, as in `stash@{0}`. */
  index: number
  message: string
}

export interface GitStat {
  /** Path inside the repository. */
  path: string
  /** Lines added; 0 for binary files. */
  added: number
  /** Lines removed; 0 for binary files. */
  deleted: number
}

export interface GitCommitEntry {
  /** Abbreviated hash. */
  hash: string
  /** Author name. */
  author: string
  /** Relative date, as git writes it. */
  date: string
  /** Subject line. */
  subject: string
}

/** Reads `git status --porcelain` (v1). */
export function parseGitStatus(text: string): GitFile[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim().length <= 2) return []
    const code = line.slice(0, 2)
    const rest = line.slice(3)
    const arrow = rest.indexOf(" -> ")
    return [
      {
        path: (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim(),
        code: code.trim(),
        staged: code[0] !== " " && code[0] !== "?",
        worktree: code[1] !== " ",
        untracked: code === "??",
      },
    ]
  })
}

/** Reads `git for-each-ref --format=%(refname:short) refs/heads`. */
export function parseGitBranches(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
}

/** Reads `git stash list --format=%gd%x09%s`. */
export function parseGitStash(text: string): GitStash[] {
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return []
    const tab = line.indexOf("\t")
    const reference = tab >= 0 ? line.slice(0, tab) : line
    const message = tab >= 0 ? line.slice(tab + 1) : ""
    const match = /stash@\{(\d+)\}/.exec(reference)
    return match ? [{ index: Number(match[1]), message }] : []
  })
}

/** Reads `git rev-list --left-right --count HEAD...@{upstream}`. */
export function parseAheadBehind(text: string): { ahead: number; behind: number } {
  const [ahead, behind] = text
    .trim()
    .split(/\s+/)
    .map((value) => Number(value) || 0)
  return { ahead: ahead ?? 0, behind: behind ?? 0 }
}

/** Reads `git diff --numstat` and `git diff --cached --numstat`. Binary files report `-` and count as 0. */
export function parseGitNumstat(text: string): GitStat[] {
  return text.split("\n").flatMap((line) => {
    const parts = line.split("\t")
    if (parts.length < 3) return []
    const added = Number(parts[0])
    const deleted = Number(parts[1])
    const raw = parts.slice(2).join("\t").trim()
    if (raw === "") return []
    // Renames show as `old => new` or `dir/{old => new}.py`.
    const path = raw.replace(/\{(?:[^{}]*) => ([^{}]*)\}/g, "$1").replace(/^.* => /, "")
    return [{ path, added: Number.isFinite(added) ? added : 0, deleted: Number.isFinite(deleted) ? deleted : 0 }]
  })
}

/** Reads `git log --format=%h%x09%an%x09%ar%x09%s`. */
export function parseGitLog(text: string): GitCommitEntry[] {
  return text.split("\n").flatMap((line) => {
    const [hash, author, date, ...subject] = line.split("\t")
    if (!hash || subject.length === 0) return []
    return [{ hash, author: author ?? "", date: date ?? "", subject: subject.join("\t") }]
  })
}

/**
 * A plain commit message built from the staged files, for when no model is available: type and scope from the
 * paths, then one line per file.
 */
export function draftCommitMessage(files: GitFile[]): string {
  if (files.length === 0) return ""
  const folders = new Set(
    files.map((file) => (file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : "")),
  )
  const scope = folders.size === 1 ? [...folders][0] : ""
  const kind =
    files.every((file) => file.untracked) || files.some((file) => file.code === "A")
      ? "feat"
      : files.some((file) => file.code === "D")
        ? "chore"
        : "fix"
  const names = [...new Set(files.map((file) => (file.path.split("/").pop() ?? file.path).split(".")[0] ?? ""))]
  const subject =
    names.length === 1
      ? `update ${names[0]}`
      : `update ${names.slice(0, 2).join(" and ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`
  const body = files
    .slice(0, 10)
    .map((file) => `- ${file.code} ${file.path}`)
    .join("\n")
  return `${kind}${scope === "" ? "" : `(${scope})`}: ${subject}\n\n${body}`
}
