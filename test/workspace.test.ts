import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectWorkspace, resolveWorkspace } from "../src/workspace"
import { writeVersion } from "../src/versions"

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "odoo-workspace-"))
  await mkdir(join(root, "odoo", "odoo"), { recursive: true })
  await mkdir(join(root, "odoo19", "odoo"), { recursive: true })
  await mkdir(join(root, "bin", "odoo-20", "odoo"), { recursive: true })
  await mkdir(join(root, "config"))
  await mkdir(join(root, "custom"))
  await mkdir(join(root, "oca"))
  await mkdir(join(root, ".venv", "bin"), { recursive: true })
  await writeFile(join(root, "odoo", "odoo-bin"), "#!/usr/bin/env python")
  await writeFile(join(root, "odoo19", "odoo-bin"), "#!/usr/bin/env python")
  await writeFile(join(root, "bin", "odoo-20", "odoo-bin"), "#!/usr/bin/env python")
  await writeFile(join(root, "odoo", "odoo", "release.py"), "version_info = (18, 0, 0, FINAL, 0, '')\n")
  await writeFile(join(root, "odoo19", "odoo", "release.py"), "version_info = (19, 0, 0, FINAL, 0, '')\n")
  await writeFile(join(root, "bin", "odoo-20", "odoo", "release.py"), "version_info = (20, 0, 0, FINAL, 0, '')\n")
  await writeFile(join(root, "config", "odoo.conf"), "[options]\n")
  await writeFile(join(root, "docker-compose.yml"), "services:\n")
  return root
}

describe("detectWorkspace", () => {
  test("detects versions from odoo-bin directories", async () => {
    const root = await fixture()
    const workspace = await detectWorkspace(root)
    const names = workspace.versions.map((version) => `${version.name}:${version.series}`)
    expect(names).toContain("odoo:18.0")
    expect(names).toContain("odoo19:19.0")
  })

  test("detects versions under bin/odoo-<major>", async () => {
    const root = await fixture()
    const workspace = await detectWorkspace(root)
    const names = workspace.versions.map((version) => `${version.name}:${version.series}`)
    expect(names).toContain("odoo-20:20.0")
    expect(workspace.versions.find((version) => version.name === "odoo-20")?.directory).toBe(
      join(root, "bin", "odoo-20"),
    )
  })

  test("detects config files", async () => {
    const root = await fixture()
    const workspace = await detectWorkspace(root)
    expect(workspace.environments.length).toBe(1)
    expect(workspace.environments[0]?.confPath).toContain("odoo.conf")
  })

  test("uses the version recorded for a configuration", async () => {
    const root = await fixture()
    await writeVersion(root, "odoo", "odoo19")
    const workspace = await detectWorkspace(root)
    expect(workspace.environments[0]?.version).toBe("odoo19")
    expect(workspace.environments[0]?.binPath).toBe(join(root, "odoo19", "odoo-bin"))
  })

  test("falls back to the first version when none is recorded", async () => {
    const root = await fixture()
    const workspace = await detectWorkspace(root)
    expect(workspace.environments[0]?.version).toBe("odoo")
  })

  test("detects docker-compose, custom, oca and venv", async () => {
    const root = await fixture()
    const workspace = await detectWorkspace(root)
    expect(workspace.dockerComposePath).toContain("docker-compose.yml")
    expect(workspace.customDirs.length).toBe(1)
    expect(workspace.ocaDirs.length).toBe(1)
    expect(workspace.venvPath).toContain(".venv")
  })
})

describe("resolveWorkspace", () => {
  test("recognizes a workspace whose only source is bin/odoo-<major>", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-bin-"))
    await mkdir(join(root, "bin", "odoo-18"), { recursive: true })
    await writeFile(join(root, "bin", "odoo-18", "odoo-bin"), "")
    const workspace = await resolveWorkspace(root)
    expect(workspace?.root).toBe(root)
    expect(workspace?.versions[0]?.name).toBe("odoo-18")
  })

  test("resolves the workspace from a nested project directory", async () => {
    const root = await fixture()
    const workspace = await resolveWorkspace(join(root, "custom"))
    expect(workspace?.root).toBe(root)
  })

  test("returns undefined when no workspace is found up the tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "odoo-none-"))
    const workspace = await resolveWorkspace(root)
    expect(workspace).toBeUndefined()
  })
})
