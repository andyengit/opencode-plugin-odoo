import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { loadSkillPack, packRoots, parseFrontmatter, parseSkill, skillInfo, virtualSkill } from "../src/skills"

const sample = `---
name: odoo-example
description: "Reviews Odoo code: models, views and security."
disable-model-invocation: true
---

# Example
`

describe("parseFrontmatter", () => {
  test("splits the leading block and unquotes values", () => {
    expect(parseFrontmatter(sample)).toEqual({
      data: { name: "odoo-example", description: "Reviews Odoo code: models, views and security.", "disable-model-invocation": "true" },
      content: "# Example",
    })
  })

  test("ignores files without a leading block", () => {
    expect(parseFrontmatter("# Example\n")).toBeUndefined()
    expect(parseFrontmatter("---\nname: x\n")).toBeUndefined()
  })
})

describe("parseSkill", () => {
  test("reads the id from the folder and disables model invocation", () => {
    expect(parseSkill("odoo-example", "/tmp/odoo-example/SKILL.md", sample)).toEqual({
      id: "odoo-example",
      name: "odoo-example",
      description: "Reviews Odoo code: models, views and security.",
      autoinvoke: false,
      path: "/tmp/odoo-example/SKILL.md",
      content: "# Example",
    })
  })

  test("skips files without a name", () => {
    expect(parseSkill("x", "/tmp/x/SKILL.md", "---\ndescription: nope\n---\n")).toBeUndefined()
  })
})

describe("loadSkillPack", () => {
  test("loads the bundled pack", async () => {
    const skills = await loadSkillPack()
    expect(skills.length).toBe(21)
    expect(skills.map((skill) => skill.id)).toContain("odoo")
    expect(skills.map((skill) => skill.id)).toContain("odoo-18.0")
    expect(skills.every((skill) => skill.name.length > 0)).toBe(true)
    expect(skills.every((skill) => skill.content.includes("#"))).toBe(true)
    expect(new Set(skills.map((skill) => skill.id)).size).toBe(skills.length)
  })

  test("keeps the bundled pack ahead of the user one", () => {
    const roots = packRoots("/custom/skills")
    expect(roots[0]).toBe("/custom/skills")
    expect(roots.length).toBeGreaterThanOrEqual(3)
  })

  test("prefers the workspace pack over the bundled one", () => {
    const roots = packRoots(undefined, "/project")
    expect(roots[0]).toBe("/project/.agents/skills")
    expect(roots).toContain(join(homedir(), ".agents", "skills"))
  })
})

describe("skillInfo", () => {
  test("uses a virtual path for generated skills", () => {
    const info = skillInfo(virtualSkill({ id: "odoo-workspace", name: "odoo-workspace", content: "# Workspace" }))
    expect(info.path).toBe("skill://odoo-workspace/SKILL.md")
    expect(info.id).toBe("odoo-workspace")
  })
})
