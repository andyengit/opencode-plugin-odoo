import { describe, expect, test } from "bun:test"
import { parseManifest } from "../src/modules"

const manifest = `{
    'name': "Payroll Venezuela",
    'version': "18.0.1.0.0",
    'summary': "Nómina para Venezuela",
    'category': "Human Resources/Payroll",
    'application': True,
    'installable': True,
    'depends': ['base', 'hr', 'l10n_ve'],
    'data': [
        'security/ir.model.access.csv',
        'views/payroll_views.xml',
    ],
}
`

describe("parseManifest", () => {
  test("reads the scalar fields", () => {
    const parsed = parseManifest(manifest)
    expect(parsed.name).toBe("Payroll Venezuela")
    expect(parsed.version).toBe("18.0.1.0.0")
    expect(parsed.category).toBe("Human Resources/Payroll")
    expect(parsed.summary).toBe("Nómina para Venezuela")
    expect(parsed.application).toBe(true)
    expect(parsed.installable).toBe(true)
  })

  test("reads the depends and data lists", () => {
    const parsed = parseManifest(manifest)
    expect(parsed.depends).toEqual(["base", "hr", "l10n_ve"])
    expect(parsed.data).toEqual(["security/ir.model.access.csv", "views/payroll_views.xml"])
  })

  test("detects a module that is not installable", () => {
    const parsed = parseManifest(`{'name': 'Old', 'installable': False, 'depends': ['base']}`)
    expect(parsed.installable).toBe(false)
  })

  test("defaults empty lists", () => {
    const parsed = parseManifest(`{'name': 'Thin'}`)
    expect(parsed.depends).toEqual([])
    expect(parsed.data).toEqual([])
    expect(parsed.application).toBe(false)
  })
})
