import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSkillPack, skillPackPath, skillPackStatus } from "../src/skillpack"

const SKILL = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n${body}\n`

describe("installSkillPack", () => {
  test("clones, reports and updates a pack", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-skillpack-"))
    const remote = join(root, "remote.git")
    const origin = join(root, "origin")
    execSync(`git init -q --bare "${remote}"`)
    execSync(`git clone -q "${remote}" "${origin}"`)
    await mkdir(join(origin, "odoo-alpha"), { recursive: true })
    await writeFile(join(origin, "odoo-alpha", "SKILL.md"), SKILL("odoo-alpha", "alpha"))
    execSync(`git -c user.name=t -c user.email=t@example.com add -A`, { cwd: origin })
    execSync(`git -c user.name=t -c user.email=t@example.com commit -qm first`, { cwd: origin })
    execSync(`git push -q origin HEAD`, { cwd: origin })

    const workspace = join(root, "workspace")
    await mkdir(workspace)
    const installed = await installSkillPack(workspace, remote)
    expect(installed).toContain("Installed")
    expect(skillPackPath(workspace)).toContain(".agents/skills/odoo-skills")
    const status = await skillPackStatus(workspace)
    expect(status.installed).toBe(true)
    expect(status.skills).toBe(1)
    expect(status.commit).toContain(" ")

    await mkdir(join(origin, "odoo-beta"), { recursive: true })
    await writeFile(join(origin, "odoo-beta", "SKILL.md"), SKILL("odoo-beta", "beta"))
    execSync(`git -c user.name=t -c user.email=t@example.com add -A`, { cwd: origin })
    execSync(`git -c user.name=t -c user.email=t@example.com commit -qm second`, { cwd: origin })
    execSync(`git push -q origin HEAD`, { cwd: origin })

    const updated = await installSkillPack(workspace, remote)
    expect(updated).toContain("Updated")
    expect((await skillPackStatus(workspace)).skills).toBe(2)
  })

  test("reports a missing pack", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-skillpack-missing-"))
    const status = await skillPackStatus(root)
    expect(status.installed).toBe(false)
    expect(status.skills).toBe(0)
  })
})
