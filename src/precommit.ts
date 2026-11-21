/** Runs the repository's pre-commit hooks (including OCA's Odoo hooks) from the Git panel. */

import { createHash } from "node:crypto"
import { access, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
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

async function runner(root: string): Promise<{ file: string; args: string[]; label: "pre-commit" | "uvx" } | undefined> {
  const direct = await runProcess("pre-commit", ["--version"], { cwd: root, timeoutMs: 15000 })
  if (direct.code === 0) return { file: "pre-commit", args: [], label: "pre-commit" }
  const uvx = join(homedir(), ".local", "bin", "uvx")
  if (await exists(uvx)) return { file: uvx, args: ["pre-commit"], label: "uvx" }
  const pathUvx = await runProcess("uvx", ["--version"], { cwd: root, timeoutMs: 15000 })
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

/** A hash of the staged diff, used to tell whether the last run still applies. */
export async function stagedDigest(root: string): Promise<string> {
  const result = await runProcess("git", ["diff", "--staged", "--no-ext-diff"], { cwd: root, timeoutMs: 60000 })
  if (result.code !== 0) return ""
  return createHash("sha1").update(result.output).digest("hex")
}

export async function runPreCommit(root: string): Promise<PreCommitRun> {
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
    [...available.args, "run", "--color=never", "--show-diff-on-failure"],
    { cwd: root, timeoutMs: 600000 },
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
