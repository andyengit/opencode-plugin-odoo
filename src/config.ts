export type OdooConfigValue = string | boolean | string[]

export interface OdooConfig {
  options: Map<string, OdooConfigValue>
  sections: Map<string, Map<string, OdooConfigValue>>
}

export function parseOdooConfig(text: string): OdooConfig {
  const config: OdooConfig = { options: new Map(), sections: new Map() }
  let section = "options"
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";")) continue
    const sectionMatch = /^\[(.+)\]$/.exec(trimmed)
    if (sectionMatch) {
      section = sectionMatch[1] ?? "options"
      continue
    }
    const index = line.indexOf("=")
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    const value = parseOdooConfigValue(line.slice(index + 1).trim())
    if (section === "options") config.options.set(key, value)
    else {
      const map = config.sections.get(section) ?? new Map()
      map.set(key, value)
      config.sections.set(section, map)
    }
  }
  return config
}

export function parseOdooConfigValue(raw: string): OdooConfigValue {
  if (raw === "True" || raw === "true") return true
  if (raw === "False" || raw === "false") return false
  const listMatch = /^\[(.*)\]$/.exec(raw)
  if (listMatch) {
    const body = listMatch[1] ?? ""
    return body
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter((item) => item.length > 0)
  }
  return raw
}

export function getString(config: OdooConfig, key: string): string | undefined {
  const value = config.options.get(key)
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "True" : "False"
  return undefined
}

export function getAddonsPath(config: OdooConfig): string[] {
  const value = config.options.get("addons_path")
  if (Array.isArray(value)) return value
  if (typeof value === "string") return value.split(",").map((item) => item.trim())
  return []
}

export function setString(config: OdooConfig, key: string, value: string | undefined) {
  if (value === undefined) config.options.delete(key)
  else config.options.set(key, value)
}

export function setAddonsPath(config: OdooConfig, paths: string[]) {
  config.options.set("addons_path", paths)
}

/**
 * Rewrites `addons_path` in place, keeping comments, ordering and every other line of the file.
 * Adds the option under `[options]` when the file has none.
 */
export function setAddonsPathText(text: string, paths: string[]): string {
  const entry = `addons_path = ${paths.join(",")}`
  const lines = text.split("\n")
  const index = lines.findIndex((line) => entryKey(line) === "addons_path")
  if (index !== -1) {
    lines[index] = entry
    return lines.join("\n")
  }
  const options = lines.findIndex((line) => line.trim() === "[options]")
  if (options !== -1) {
    lines.splice(options + 1, 0, entry)
    return lines.join("\n")
  }
  return `${entry}\n${text}`
}

export function serializeOdooConfig(config: OdooConfig): string {
  const lines: string[] = []
  lines.push("[options]")
  for (const [key, value] of config.options) lines.push(serializeEntry(key, value))
  for (const [section, map] of config.sections) {
    lines.push("")
    lines.push(`[${section}]`)
    for (const [key, value] of map) lines.push(serializeEntry(key, value))
  }
  return lines.join("\n") + "\n"
}

/**
 * Sets (or removes, with `value` undefined) one entry inside a section, editing the file in place so comments,
 * ordering and every other line survive. Creates the section at the end when it does not exist yet.
 */
export function setEntryText(text: string, section: string, key: string, value: string | undefined): string {
  const lines = text.split("\n")
  const isOptions = section === "options"
  const header = lines.findIndex((line) => line.trim() === `[${section}]`)

  if (!isOptions && header === -1) {
    if (value === undefined) return text
    const body = text.trimEnd()
    return `${body === "" ? "" : `${body}\n\n`}[${section}]\n${key} = ${value}\n`
  }

  const start = header === -1 ? 0 : header + 1
  let end = lines.length
  for (let index = start; index < lines.length; index++) {
    const trimmed = lines[index]?.trim() ?? ""
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      end = index
      break
    }
  }

  const existing = lines.findIndex((line, index) => index >= start && index < end && entryKey(line) === key)
  if (value === undefined) {
    if (existing === -1) return text
    lines.splice(existing, 1)
    return lines.join("\n")
  }

  const entry = `${key} = ${value}`
  if (existing !== -1) {
    lines[existing] = entry
    return lines.join("\n")
  }

  let insertAt = end
  while (insertAt > start && (lines[insertAt - 1]?.trim() ?? "") === "") insertAt--
  lines.splice(insertAt, 0, entry)
  return lines.join("\n")
}

/**
 * Merges `key = value` lines into an existing configuration text, replacing a matching entry in place and
 * inserting new ones at the end of their section (the `[options]` section unless the text names another one).
 * Comments, ordering and every other line survive, so the result adds to the file instead of replacing it.
 */
export function applyConfigLines(text: string, extra: string): { text: string; keys: string[] } {
  let next = text
  let section = "options"
  const keys: string[] = []
  for (const raw of extra.split("\n")) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = (header[1] ?? "options").trim() || "options"
      continue
    }
    const index = line.indexOf("=")
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key.length === 0) continue
    next = setEntryText(next, section, key, line.slice(index + 1).trim())
    if (!keys.includes(key)) keys.push(key)
  }
  return { text: next, keys }
}

function entryKey(line: string): string | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("[")) return
  const index = line.indexOf("=")
  if (index <= 0) return
  return line.slice(0, index).trim()
}

function serializeEntry(key: string, value: OdooConfigValue): string {
  if (Array.isArray(value)) return `${key} = ${value.map((item) => item).join(",")}`
  if (typeof value === "boolean") return `${key} = ${value ? "True" : "False"}`
  return `${key} = ${value}`
}
