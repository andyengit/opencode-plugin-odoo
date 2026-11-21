/** Runs the repository's pre-commit hooks (including OCA's Odoo hooks) from the Git panel. */

import { createHash } from "node:crypto"
import { access, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { runProcess } from "./execute"

export const PRECOMMIT_CONFIG = `repos:
  - repo: https://github.com/OCA/odoo-pre-commit-hooks
    rev: v0.2.27
    hooks:
      - id: oca-checks-odoo-module
      - id: oca-checks-po
        args: ["--fix"]
`

export type PreCommitState = "passed" | "failed" | "missing" | "error"

export interface PreCommitInfo {
  configured: boolean
  /** The config references OCA's odoo-pre-commit-hooks. */
  oca: boolean
  /** The command that would run the hooks, empty when none is available. */
  runner: "pre-commit" | "uvx" | ""
}

export interface PreCommitRun {
  state: PreCommitState
  output: string
  durationMs: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function configFile(root: string): Promise<string | undefined> {
  for (const name of [".pre-commit-config.yaml", ".pre-commit-config.yml"]) {
    const path = join(root, name)
    if (await exists(path)) return path
  }
  return undefined
}

async function findUp(start: string, relative: string): Promise<string | undefined> {
  let directory = start
  for (;;) {
    const candidate = join(directory, relative)
    if (await exists(candidate)) return candidate
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/** The app's PATH can be smaller than a login shell's; installs usually live in these folders. */
function runEnv(): NodeJS.ProcessEnv {
  const bins = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]
  return { ...process.env, PATH: [...bins, process.env.PATH ?? ""].filter(Boolean).join(":") }
}

async function runner(root: string): Promise<{ file: string; args: string[]; label: "pre-commit" | "uvx" } | undefined> {
  const candidates = [
    await findUp(root, join(".venv", "bin", "pre-commit")),
    join(homedir(), ".local", "bin", "pre-commit"),
    join(homedir(), ".local", "share", "uv", "tools", "pre-commit", "bin", "pre-commit"),
    join(homedir(), ".local", "pipx", "venvs", "pre-commit", "bin", "pre-commit"),
    "/opt/homebrew/bin/pre-commit",
    "/usr/local/bin/pre-commit",
  ].filter((path): path is string => typeof path === "string")
  for (const file of candidates) {
    if (await exists(file)) return { file, args: [], label: "pre-commit" }
  }
  const direct = await runProcess("pre-commit", ["--version"], { cwd: root, timeoutMs: 15000, env: runEnv() })
  if (direct.code === 0) return { file: "pre-commit", args: [], label: "pre-commit" }
  const uvx = join(homedir(), ".local", "bin", "uvx")
  if (await exists(uvx)) return { file: uvx, args: ["pre-commit"], label: "uvx" }
  const pathUvx = await runProcess("uvx", ["--version"], { cwd: root, timeoutMs: 15000, env: runEnv() })
  if (pathUvx.code === 0) return { file: "uvx", args: ["pre-commit"], label: "uvx" }
  return undefined
}

export async function preCommitInfo(root: string): Promise<PreCommitInfo> {
  const config = await configFile(root)
  const available = await runner(root)
  const text = config ? await readFile(config, "utf8").catch(() => "") : ""
  return {
    configured: config !== undefined,
    oca: text.includes("odoo-pre-commit-hooks"),
    runner: available?.label ?? "",
  }
}

/** The files a run checks: staged changes only, or every file of the repository. */
export type PreCommitScope = "staged" | "all"

/** A hash of the files the selected scope would check, used to tell whether the last run still applies. */
export async function repositoryDigest(root: string, scope: PreCommitScope = "staged"): Promise<string> {
  if (scope === "all") {
    const [diff, status] = await Promise.all([
      runProcess("git", ["diff", "HEAD", "--no-ext-diff"], { cwd: root, timeoutMs: 60000 }),
      runProcess("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, timeoutMs: 60000 }),
    ])
    if (diff.code !== 0) return ""
    return createHash("sha1").update(`${status.output}\n${diff.output}`).digest("hex")
  }
  const result = await runProcess("git", ["diff", "--staged", "--no-ext-diff"], { cwd: root, timeoutMs: 60000 })
  if (result.code !== 0) return ""
  return createHash("sha1").update(result.output).digest("hex")
}

export async function stagedDigest(root: string): Promise<string> {
  return repositoryDigest(root, "staged")
}

export async function runPreCommit(root: string, scope: PreCommitScope = "staged"): Promise<PreCommitRun> {
  if (!(await configFile(root))) {
    return {
      state: "missing",
      output: "No .pre-commit-config.yaml in this repository. Install the OCA hooks first.",
      durationMs: 0,
    }
  }
  const available = await runner(root)
  if (!available) {
    return {
      state: "error",
      output: "pre-commit is not installed. Install it with `uv tool install pre-commit` or `pipx install pre-commit`.",
      durationMs: 0,
    }
  }
  const started = Date.now()
  const result = await runProcess(
    available.file,
    [
      ...available.args,
      "run",
      "--color=never",
      "--show-diff-on-failure",
      ...(scope === "all" ? ["--all-files"] : []),
    ],
    { cwd: root, timeoutMs: 600000, env: runEnv() },
  )
  return {
    state: result.code === 0 ? "passed" : "failed",
    output: result.output.trim(),
    durationMs: Date.now() - started,
  }
}

/** Creates a minimal OCA pre-commit config when the repository has none. */
export async function setupPreCommit(root: string): Promise<string> {
  if (await configFile(root)) return "The repository already has a pre-commit config"
  await writeFile(join(root, ".pre-commit-config.yaml"), PRECOMMIT_CONFIG)
  return "Created .pre-commit-config.yaml with the OCA Odoo hooks"
}
