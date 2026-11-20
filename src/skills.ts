import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Skill } from "@opencode/plugin"

/**
 * The plugin's own folder, without relying on `import.meta` alone: some hosts transpile plugins to
 * CommonJS where `import.meta` is emulated with globals that are not defined, which used to crash the
 * whole plugin before it could register anything.
 */
export function pluginRoot(): string {
  try {
    const url = import.meta.url
    if (typeof url === "string" && url.startsWith("file:")) {
      return resolve(dirname(fileURLToPath(url)), "..")
    }
  } catch {
    // fall through to the CommonJS shim, then to nothing
  }
  const shim = globalThis as { __dirname?: string }
  if (typeof shim.__dirname === "string" && shim.__dirname !== "") {
    return resolve(shim.__dirname, "..")
  }
  return ""
}

const PLUGIN_ROOT = pluginRoot()

export interface SkillFile {
  id: string
  name: string
  description?: string
  autoinvoke?: boolean
  path: string
  content: string
}

export interface Frontmatter {
  data: Record<string, string>
  content: string
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (["true", "yes", "on", "1"].includes(normalized)) return true
  if (["false", "no", "off", "0"].includes(normalized)) return false
  return undefined
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

/** Reads the leading `---` block of a skill file without pulling in a YAML parser. */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const lines = text.split("\n")
  if ((lines[0] ?? "").trim() !== "---") return undefined
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
  if (end === -1) return undefined
  const data: Record<string, string> = {}
  for (const line of lines.slice(1, end)) {
    if (line.trim().length === 0 || /^\s/.test(line)) continue
    const index = line.indexOf(":")
    if (index <= 0) continue
    data[line.slice(0, index).trim()] = unquote(line.slice(index + 1))
  }
  return { data, content: lines.slice(end + 1).join("\n").trim() }
}

export function parseSkill(id: string, path: string, text: string): SkillFile | undefined {
  const parsed = parseFrontmatter(text)
  if (!parsed) return undefined
  const name = parsed.data.name?.trim()
  if (!name) return undefined
  const description = parsed.data.description?.trim()
  const autoinvoke = booleanValue(parsed.data["disable-model-invocation"]) === true ? false : undefined
  return {
    id,
    name,
    ...(description ? { description } : {}),
    ...(autoinvoke === undefined ? {} : { autoinvoke }),
    path,
    content: parsed.content,
  }
}

/** Finds every `SKILL.md` up to three folders deep, stopping at the first directory that holds one. */
export async function findSkillFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 3) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((entry) => entry.isFile() && entry.name === "SKILL.md").map((entry) => join(root, entry.name))
  // A directory with a SKILL.md is a skill; its references are not skills.
  if (files.length > 0) return files
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => findSkillFiles(join(root, entry.name), depth + 1)),
  )
  return nested.flat()
}

/** Candidate skill packs, in priority order: explicit option, project pack, bundled pack, user-level pack. */
export function packRoots(custom?: string, workspaceRoot?: string): string[] {
  const expand = (root: string) => (root.startsWith("~/") ? join(homedir(), root.slice(2)) : root)
  return [
    custom,
    workspaceRoot ? join(workspaceRoot, ".agents", "skills") : undefined,
    join(PLUGIN_ROOT, "skills"),
    join(homedir(), ".agents", "skills"),
  ]
    .filter((root): root is string => typeof root === "string" && root.length > 0)
    .map(expand)
}

/** Loads every skill of the first pack that exists, so the plugin never depends on a manual install. */
export async function loadSkillPack(custom?: string, workspaceRoot?: string): Promise<SkillFile[]> {
  for (const root of packRoots(custom, workspaceRoot)) {
    const files = await findSkillFiles(root)
    if (files.length === 0) continue
    const skills: SkillFile[] = []
    for (const path of files) {
      const text = await readFile(path, "utf8").catch(() => undefined)
      if (!text) continue
      const skill = parseSkill(basename(dirname(path)), path, text)
      if (skill) skills.push(skill)
    }
    if (skills.length > 0) return skills.sort((a, b) => a.id.localeCompare(b.id))
  }
  return []
}

/** Builds a skill whose body lives in memory instead of on disk. */
export function virtualSkill(skill: Omit<SkillFile, "path">): SkillFile {
  return { ...skill, path: `skill://${skill.id}/SKILL.md` }
}

export function skillInfo(skill: SkillFile): Skill.Info {
  return {
    id: skill.id as Skill.Info["id"],
    name: skill.name as Skill.Info["name"],
    ...(skill.description === undefined ? {} : { description: skill.description }),
    ...(skill.autoinvoke === undefined ? {} : { autoinvoke: skill.autoinvoke }),
    path: skill.path as Skill.Info["path"],
    content: skill.content,
  }
}
