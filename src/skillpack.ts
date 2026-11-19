/** Installs and updates the shared Odoo skill pack inside every workspace. */

import { access, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { runProcess } from "./execute"
import { findSkillFiles } from "./skills"

export const SKILL_PACK_REPO = "https://github.com/mart337i/odoo-skills"

export interface SkillPackStatus {
  installed: boolean
  path: string
  branch: string
  commit: string
  skills: number
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runProcess("git", args, { cwd, timeoutMs: 180000 })
  if (result.code !== 0) {
    const tail = result.output.trim().split("\n").slice(-3).join(" ").trim()
    throw new Error(tail || `git ${args[0]} failed`)
  }
  return result.output
}

/** The clone of the shared pack that lives inside a workspace. */
export function skillPackPath(root: string): string {
  return join(root, ".agents", "skills", "odoo-skills")
}

export async function skillPackStatus(root: string): Promise<SkillPackStatus> {
  const path = skillPackPath(root)
  if (!(await exists(join(path, ".git")))) {
    return { installed: false, path, branch: "", commit: "", skills: 0 }
  }
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], path)).trim()
  const commit = (await git(["log", "-1", "--format=%h %cr"], path)).trim()
  const skills = (await findSkillFiles(path)).length
  return { installed: true, path, branch, commit, skills }
}

/** Clones the pack into the workspace, or fast-forwards the existing clone. */
export async function installSkillPack(root: string, remote = SKILL_PACK_REPO): Promise<string> {
  const path = skillPackPath(root)
  if (await exists(join(path, ".git"))) {
    await git(["pull", "--ff-only"], path)
    return `Updated ${SKILL_PACK_REPO.split("/").pop()} in .agents/skills`
  }
  await mkdir(join(root, ".agents", "skills"), { recursive: true })
  await git(["clone", "--depth", "1", remote, path], root)
  return `Installed ${SKILL_PACK_REPO.split("/").pop()} in .agents/skills`
}
