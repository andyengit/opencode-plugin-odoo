import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyRecommendation, recommend, workspaceSkill } from "../src/recommend"
import { detectWorkspace } from "../src/workspace"

let root = ""

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "odoo-recommend-"))
  await mkdir(join(root, "bin", "odoo-18", "odoo"), { recursive: true })
  await mkdir(join(root, "config"), { recursive: true })
  await writeFile(join(root, "bin", "odoo-18", "odoo-bin"), "")
  await writeFile(join(root, "bin", "odoo-18", "odoo", "release.py"), "version_info = (18, 0, 1, 0)\n")
  await writeFile(join(root, "config", "local.conf"), "[options]\naddons_path = /addons/custom,/addons/oca\n")
  await writeFile(join(root, "README.md"), "# Local tooling\n")
})

afterAll(() => rm(root, { recursive: true, force: true }))

describe("recommend", () => {
  test("derives the recommended environment from the active configuration", async () => {
    const workspace = await detectWorkspace(root)
    const recommendation = await recommend(workspace)
    expect(recommendation.source).toBe(join(root, "bin", "odoo-18"))
    expect(recommendation.baseCommand).toBe(
      `python3 ${join(root, "bin", "odoo-18", "odoo-bin")} -c ${join(root, "config", "local.conf")}`,
    )
    expect(recommendation.toolReadme).toBe(join(root, "README.md"))
    expect(recommendation.addonsPath).toEqual(["/addons/custom", "/addons/oca"])
  })

  test("exports only the variables the user has not set", async () => {
    const recommendation = { source: "/odoo", baseCommand: "python3 odoo-bin", toolReadme: "/README.md" }
    const keys = ["ODOO_SOURCE", "ODOO_BASE_COMMAND", "ODOO_TOOL_README"]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    process.env.ODOO_SOURCE = "/explicit"
    try {
      const result = applyRecommendation(recommendation)
      expect(result.kept).toEqual(["ODOO_SOURCE"])
      expect(result.applied).toEqual(["ODOO_BASE_COMMAND", "ODOO_TOOL_README"])
      expect(process.env.ODOO_SOURCE).toBe("/explicit")
      expect(process.env.ODOO_BASE_COMMAND).toBe("python3 odoo-bin")
    } finally {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("replaces plugin values on a workspace switch but keeps user values", async () => {
    const recommendation = { source: "/odoo", baseCommand: "python3 odoo-bin", toolReadme: "/README.md" }
    const keys = ["ODOO_SOURCE", "ODOO_BASE_COMMAND", "ODOO_TOOL_README"]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    try {
      applyRecommendation({ source: "/first", baseCommand: "first", toolReadme: "/first/README.md" })
      const result = applyRecommendation(recommendation)
      expect(result.kept).toEqual([])
      expect(process.env.ODOO_SOURCE).toBe("/odoo")
      expect(result.applied).toEqual(["ODOO_SOURCE", "ODOO_BASE_COMMAND", "ODOO_TOOL_README"])
    } finally {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("force overwrites values exported outside the plugin", async () => {
    const keys = ["ODOO_SOURCE", "ODOO_BASE_COMMAND", "ODOO_TOOL_README"]
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    process.env.ODOO_SOURCE = "/explicit"
    try {
      const result = applyRecommendation(
        { source: "/odoo", baseCommand: "python3 odoo-bin", toolReadme: "/README.md" },
        { force: true },
      )
      expect(result.applied).toContain("ODOO_SOURCE")
      expect(process.env.ODOO_SOURCE).toBe("/odoo")
    } finally {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe("workspaceSkill", () => {
  test("lists the configuration and the recommended variables", async () => {
    const workspace = await detectWorkspace(root)
    const skill = workspaceSkill(workspace, await recommend(workspace))
    expect(skill.id).toBe("odoo-workspace")
    expect(skill.path).toBe("skill://odoo-workspace/SKILL.md")
    expect(skill.content).toContain(`Root: \`${root}\``)
    expect(skill.content).toContain("Active configuration: `local` (Odoo `odoo-18`)")
    expect(skill.content).toContain(`export ODOO_SOURCE=${join(root, "bin", "odoo-18")}`)
    expect(skill.content).toContain("export ODOO_BASE_COMMAND=")
  })
})
