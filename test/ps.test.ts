import { describe, expect, test } from "bun:test"
import { parseProcesses } from "../src/ps"

describe("parseProcesses", () => {
  test("keeps odoo-bin processes and reads their configuration", () => {
    const output = [
      "  1234 /w/bin/odoo-18/.venv/bin/python /w/bin/odoo-18/odoo-bin -c /Users/andy/workspace/config/odoo.conf --http-port 8071",
      "  2345 /opt/odoo/odoo-bin --config=/srv/prod/odoo.conf -d produccion",
      "  3456 /usr/bin/grep odoo-bin",
      "  4567 node server.js",
    ].join("\n")
    expect(parseProcesses(output)).toEqual([
      { pid: 1234, conf: "/Users/andy/workspace/config/odoo.conf", database: "", label: "workspace/odoo.conf" },
      { pid: 2345, conf: "/srv/prod/odoo.conf", database: "produccion", label: "prod/odoo.conf" },
    ])
  })

  test("reads quoted paths and the database without a config", () => {
    const output = [
      '  111 /usr/local/bin/python3 /srv/odoo/odoo-bin -c "/srv/my server/odoo.conf" -d client',
      "  222 /srv/odoo/odoo-bin -d solo_db",
    ].join("\n")
    expect(parseProcesses(output)).toEqual([
      { pid: 111, conf: "/srv/my server/odoo.conf", database: "client", label: "my server/odoo.conf" },
      { pid: 222, conf: "", database: "solo_db", label: "solo_db" },
    ])
  })

  test("returns nothing for output without Odoo", () => {
    expect(parseProcesses("  1 /sbin/launchd\n  2 /usr/sbin/syslogd\n")).toEqual([])
  })
})
