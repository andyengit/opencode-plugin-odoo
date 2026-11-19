import { describe, expect, test } from "bun:test"
import {
  applyConfigLines,
  getAddonsPath,
  getString,
  parseOdooConfig,
  setAddonsPath,
  setEntryText,
  setString,
  serializeOdooConfig,
  setAddonsPathText,
} from "../src/config"

const sample = `[options]
addons_path = /a/addons,/b/odoo/addons,/c/custom
data_dir = /var/lib/odoo
db_host = 127.0.0.1
db_port = 5432
db_user = odoo
db_password = odoo
list_db = True
http_port = 8069
workers = 0
translate_modules = ['all']
admin_passwd = $pbkdf2-sha512$600000$abc

[queue_job]
channels = root:2
`

describe("parseOdooConfig", () => {
  test("parses scalar options", () => {
    const config = parseOdooConfig(sample)
    expect(getString(config, "db_host")).toBe("127.0.0.1")
    expect(getString(config, "db_port")).toBe("5432")
    expect(getString(config, "db_user")).toBe("odoo")
    expect(getString(config, "http_port")).toBe("8069")
  })

  test("parses booleans", () => {
    const config = parseOdooConfig(sample)
    expect(config.options.get("list_db")).toBe(true)
  })

  test("parses addons_path as a list", () => {
    const config = parseOdooConfig(sample)
    expect(getAddonsPath(config)).toEqual(["/a/addons", "/b/odoo/addons", "/c/custom"])
  })

  test("parses python list values", () => {
    const config = parseOdooConfig(sample)
    expect(config.options.get("translate_modules")).toEqual(["all"])
  })

  test("parses non-options sections", () => {
    const config = parseOdooConfig(sample)
    expect(config.sections.get("queue_job")?.get("channels")).toBe("root:2")
  })
})

describe("serializeOdooConfig", () => {
  test("round-trips scalar values", () => {
    const config = parseOdooConfig(sample)
    const output = serializeOdooConfig(config)
    const reparsed = parseOdooConfig(output)
    expect(getString(reparsed, "db_host")).toBe("127.0.0.1")
    expect(getString(reparsed, "http_port")).toBe("8069")
  })

  test("round-trips addons_path", () => {
    const config = parseOdooConfig(sample)
    const output = serializeOdooConfig(config)
    const reparsed = parseOdooConfig(output)
    expect(getAddonsPath(reparsed)).toEqual(["/a/addons", "/b/odoo/addons", "/c/custom"])
  })
})

describe("mutations", () => {
  test("setString updates a value", () => {
    const config = parseOdooConfig(sample)
    setString(config, "db_port", "5433")
    expect(getString(config, "db_port")).toBe("5433")
  })

  test("setString removes a key when undefined", () => {
    const config = parseOdooConfig(sample)
    setString(config, "db_password", undefined)
    expect(config.options.has("db_password")).toBe(false)
  })

  test("setAddonsPath replaces the list", () => {
    const config = parseOdooConfig(sample)
    setAddonsPath(config, ["/x", "/y"])
    const output = serializeOdooConfig(config)
    expect(output).toContain("addons_path = /x,/y")
  })
})

describe("applyConfigLines", () => {
  test("appends new keys without touching the rest of the file", () => {
    const source = `[options]\n# keep me\ndb_port = 5432\n`
    const { text, keys } = applyConfigLines(source, "workers = 2\ndev = all")
    expect(keys).toEqual(["workers", "dev"])
    expect(text).toContain("# keep me")
    expect(text).toContain("dev = all")
    expect(parseOdooConfig(text).options.get("dev")).toBe("all")
  })

  test("updates an existing key in place", () => {
    const { text, keys } = applyConfigLines(sample, "workers = 4")
    expect(keys).toEqual(["workers"])
    expect(text.match(/workers =/g)?.length).toBe(1)
    expect(getString(parseOdooConfig(text), "workers")).toBe("4")
  })

  test("keeps new options inside the options section", () => {
    const { text } = applyConfigLines(sample, "dev = all")
    expect(text.indexOf("dev = all")).toBeLessThan(text.indexOf("[queue_job]"))
  })

  test("ignores comments and blank lines, and keeps a pasted section apart", () => {
    const { text, keys } = applyConfigLines(sample, "# note\n\n[extra]\nworkers = 1")
    expect(keys).toEqual(["workers"])
    expect(text).toContain("[extra]")
    expect(parseOdooConfig(text).sections.get("extra")?.get("workers")).toBe("1")
    expect(getString(parseOdooConfig(text), "workers")).toBe("0")
  })

  test("keeps a pasted queue_job entry out of options", () => {
    const { text, keys } = applyConfigLines(sample, "[queue_job]\nchannel = root")
    expect(keys).toEqual(["channel"])
    const config = parseOdooConfig(text)
    expect(config.sections.get("queue_job")?.get("channel")).toBe("root")
    expect(config.sections.get("queue_job")?.get("channels")).toBe("root:2")
    expect(config.options.has("channel")).toBe(false)
  })

  test("returns no keys when nothing parses", () => {
    const { text, keys } = applyConfigLines(sample, "not an option")
    expect(keys).toEqual([])
    expect(text).toBe(sample)
  })
})

describe("setEntryText", () => {
  test("updates an option in place and keeps comments", () => {
    const source = `[options]\n# keep me\ndb_port = 5432\n\n[queue_job]\nchannels = root:2\n`
    const text = setEntryText(source, "options", "db_port", "5433")
    expect(text).toContain("# keep me")
    expect(text).toContain("db_port = 5433")
    expect(text).toContain("channels = root:2")
    expect(text.match(/db_port =/g)?.length).toBe(1)
  })

  test("adds an option at the end of options, before the next section", () => {
    const text = setEntryText(sample, "options", "proxy_mode", "True")
    expect(text.indexOf("proxy_mode = True")).toBeLessThan(text.indexOf("[queue_job]"))
    expect(parseOdooConfig(text).options.get("proxy_mode")).toBe(true)
  })

  test("updates an entry inside a section without touching options", () => {
    const text = setEntryText(sample, "queue_job", "channels", "root:4")
    const config = parseOdooConfig(text)
    expect(config.sections.get("queue_job")?.get("channels")).toBe("root:4")
    expect(config.options.has("channels")).toBe(false)
  })

  test("creates the section when it does not exist", () => {
    const text = setEntryText("[options]\ndb_port = 5432\n", "queue_job", "channel", "root")
    expect(text).toContain("[queue_job]")
    expect(parseOdooConfig(text).sections.get("queue_job")?.get("channel")).toBe("root")
    expect(getString(parseOdooConfig(text), "db_port")).toBe("5432")
  })

  test("removes an entry and leaves the rest", () => {
    const text = setEntryText(sample, "queue_job", "channels", undefined)
    expect(text).not.toContain("channels = root:2")
    expect(text).toContain("[queue_job]")
    expect(getString(parseOdooConfig(text), "db_port")).toBe("5432")
  })
})

describe("setAddonsPathText", () => {
  test("rewrites addons_path in place and keeps comments", () => {
    const source = `[options]\n# keep me\naddons_path = /a,/b\ndb_port = 5432\n`
    const output = setAddonsPathText(source, ["/a", "/c"])
    expect(output).toContain("# keep me")
    expect(output).toContain("addons_path = /a,/c")
    expect(output).not.toContain("/b")
    expect(output).toContain("db_port = 5432")
  })

  test("adds the option under [options] when missing", () => {
    const output = setAddonsPathText("[options]\ndb_port = 5432\n", ["/x"])
    expect(output.split("\n")[1]).toBe("addons_path = /x")
  })
})
