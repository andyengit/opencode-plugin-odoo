import { readdir, readFile, stat } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { dirname, join } from "node:path"
import { readVersionMap } from "./versions"

export interface OdooVersion {
  name: string
  series: string
  directory: string
}

export interface OdooEnvironment {
  label: string
  confPath: string
  binPath: string
  version?: string
  args: string[]
  active: boolean
}

export interface OdooWorkspace {
  root: string
  versions: OdooVersion[]
  environments: OdooEnvironment[]
  dockerComposePath?: string
  customDirs: string[]
  ocaDirs: string[]
  venvPath?: string
}

export async function detectWorkspace(root: string): Promise<OdooWorkspace> {
  const entries = await readdir(root, { withFileTypes: true })
  const versions = await detectVersions(root, entries)
  const confFiles: string[] = []
  let dockerComposePath: string | undefined
  const customDirs: string[] = []
  const ocaDirs: string[] = []
  let venvPath: string | undefined

  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.name === "docker-compose.yml") dockerComposePath = full
    if (entry.isDirectory() && entry.name === "custom") customDirs.push(full)
    if (entry.isDirectory() && entry.name === "oca") ocaDirs.push(full)
    if (entry.isDirectory() && entry.name === ".venv") venvPath = full
  }

  const configDir = join(root, "config")
  if (await isDirectory(configDir)) {
    const configEntries = await readdir(configDir)
    confFiles.push(...configEntries.filter((name) => name.endsWith(".conf")).map((name) => join(configDir, name)))
  }
  confFiles.push(
    ...entries.filter((entry) => entry.isFile() && entry.name.endsWith(".conf")).map((entry) => join(root, entry.name)),
  )

  const environments = await applyVersions(root, versions, await detectEnvironments(root, versions, confFiles))

  return {
    root,
    versions,
    environments,
    dockerComposePath,
    customDirs,
    ocaDirs,
    venvPath,
  }
}

export async function resolveWorkspace(start: string): Promise<OdooWorkspace | undefined> {
  const root = await findWorkspaceRoot(start)
  return root ? detectWorkspace(root) : undefined
}

export async function findWorkspaceRoot(start: string): Promise<string | undefined> {
  let directory = (await isDirectory(start)) ? start : dirname(start)
  while (true) {
    if (await isWorkspaceRoot(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

async function isWorkspaceRoot(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const names = new Set(entries.map((entry) => entry.name))

  if (names.has("docker-compose.yml") || names.has("docker-compose.yaml")) return true
  if (names.has("odoo.conf") || names.has("odools.toml")) return true

  if (names.has("config")) {
    const config = await readdir(join(directory, "config")).catch(() => [])
    if (config.some((name) => name.endsWith(".conf"))) return true
  }

  const versionDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("odoo"))
  const hasVersion = (await Promise.all(versionDirs.map((entry) => hasOdooBin(join(directory, entry.name))))).some(
    Boolean,
  )
  if (hasVersion) return true

  const binDir = join(directory, "bin")
  const binDirs = (await readdir(binDir, { withFileTypes: true }).catch(() => [])).filter((entry) =>
    entry.isDirectory(),
  )
  return (await Promise.all(binDirs.map((entry) => hasOdooBin(join(binDir, entry.name))))).some(Boolean)
}

async function hasOdooBin(directory: string): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.some((entry) => entry.isFile() && entry.name === "odoo-bin")
}

/** Odoo sources live at the workspace root (older layouts) or, preferably, in `bin/odoo-<major>`. */
async function detectVersions(root: string, entries: Dirent[]): Promise<OdooVersion[]> {
  const versions: OdooVersion[] = []
  const add = async (name: string, directory: string) => {
    if (!(await hasOdooBin(directory))) return
    versions.push({ name, series: await detectSeries(directory), directory })
  }
  for (const entry of entries) if (entry.isDirectory()) await add(entry.name, join(root, entry.name))
  const binDir = join(root, "bin")
  const binEntries = await readdir(binDir, { withFileTypes: true }).catch(() => [])
  for (const entry of binEntries) if (entry.isDirectory()) await add(entry.name, join(binDir, entry.name))
  return versions
}

async function detectSeries(directory: string): Promise<string> {
  const releasePath = join(directory, "odoo", "release.py")
  try {
    const text = await readFile(releasePath, "utf8")
    const infoMatch = /^version_info\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*,/m.exec(text)
    if (infoMatch) return `${infoMatch[1]}.${infoMatch[2]}`
    const seriesMatch = /^series\s*=\s*serie\s*=\s*major_version\s*=\s*['"]([^'"]+)['"]/m.exec(text)
    const series = seriesMatch?.[1]
    if (series && !series.includes(".") && series !== ".") return series
  } catch {
    return fallbackSeries(directory)
  }
  return fallbackSeries(directory)
}

function fallbackSeries(directory: string): string {
  const name = directory.split("/").pop() ?? ""
  const match = /^odoo-?(\d+)(?:\.\d+)?$/.exec(name)
  if (match) return `${match[1][0]}.0`
  return name
}

async function detectEnvironments(
  root: string,
  versions: OdooVersion[],
  confFiles: string[],
): Promise<OdooEnvironment[]> {
  const shortcutsPath = join(root, ".vscode", "shortcuts.json")
  try {
    const shortcuts = await readShortcuts(shortcutsPath)
    if (shortcuts.length > 0) return shortcuts
  } catch {
    // fall through to conf-file detection
  }

  const environments: OdooEnvironment[] = []
  for (const confPath of confFiles) {
    const version = versions[0]
    environments.push({
      label: confName(confPath),
      confPath,
      binPath: version ? join(version.directory, "odoo-bin") : "",
      version: version?.name,
      args: [],
      active: environments.length === 0,
    })
  }
  return environments
}

/** Points each configuration at the Odoo source recorded for it, falling back to the detected bin. */
async function applyVersions(
  root: string,
  versions: OdooVersion[],
  environments: OdooEnvironment[],
): Promise<OdooEnvironment[]> {
  const map = await readVersionMap(root)
  return environments.map((environment) => {
    const chosen = versions.find((version) => version.name === map[environment.label])
    const binPath = chosen ? join(chosen.directory, "odoo-bin") : environment.binPath
    return {
      ...environment,
      binPath,
      version: versions.find((version) => join(version.directory, "odoo-bin") === binPath)?.name,
    }
  })
}

interface Shortcut {
  label: string
  odooBinPath?: string
  odooConfPath?: string
  config?: string[]
  active?: boolean
}

async function readShortcuts(path: string): Promise<OdooEnvironment[]> {
  const text = await readFile(path, "utf8")
  const items = JSON.parse(text) as Shortcut[]
  const root = join(path, "..", "..")
  return items.map((item) => ({
    label: item.label,
    confPath: resolveShortcutPath(root, item.odooConfPath ?? ""),
    binPath: resolveShortcutPath(root, item.odooBinPath ?? ""),
    args: item.config ?? [],
    active: item.active ?? false,
  }))
}

function resolveShortcutPath(root: string, path: string): string {
  const trimmed = path.trim()
  if (trimmed.startsWith("${workspaceFolder}/")) return join(root, trimmed.slice("${workspaceFolder}/".length))
  if (trimmed.startsWith("${workspaceFolder}"))
    return join(root, trimmed.slice("${workspaceFolder}".length).replace(/^\//, ""))
  return trimmed
}

function confName(confPath: string): string {
  return (confPath.split("/").pop() ?? confPath).replace(/\.conf$/, "")
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
