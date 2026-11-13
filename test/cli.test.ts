import { describe, expect, test } from "bun:test"
import { CLI_MARKER, cliDispatcher, cliLauncher, cliState } from "../src/cli"

describe("cliState", () => {
  test("names the three files of the active configuration", () => {
    expect(
      cliState({
        python: "/w/bin/odoo-18/.venv/bin/python",
        odooBin: "/w/bin/odoo-18/odoo-bin",
        conf: "/w/config/odoo.conf",
      }),
    ).toBe(
      [
        CLI_MARKER,
        "PYTHON='/w/bin/odoo-18/.venv/bin/python'",
        "ODOO_BIN='/w/bin/odoo-18/odoo-bin'",
        "CONF='/w/config/odoo.conf'",
        "",
      ].join("\n"),
    )
  })

  test("escapes single quotes so sourcing keeps the path", () => {
    expect(cliState({ python: "/a'b", odooBin: "/c", conf: "/d" })).toContain("PYTHON='/a'\\''b'")
  })
})

describe("cliLauncher", () => {
  test("runs the version's python with the active conf", () => {
    const script = cliLauncher()
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true)
    expect(script).toContain("odoo-cli.env")
    expect(script).toContain('exec "${PYTHON}" "${ODOO_BIN}" -c "${CONF}" "$@"')
  })

  test("leaves a config passed with -c alone", () => {
    expect(cliLauncher()).toContain("has_conf=1")
    expect(cliLauncher()).toContain('exec "${PYTHON}" "${ODOO_BIN}" "$@"')
  })
})

describe("cliDispatcher", () => {
  test("walks up to the nearest bin/odoo", () => {
    const script = cliDispatcher()
    expect(script).toContain('if [[ -x "${dir}/bin/odoo" ]]')
    expect(script).toContain('dir="$(dirname "${dir}")"')
  })
})
