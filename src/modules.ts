import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"

/** The parts of an Odoo manifest the context tools report. */
export interface OdooManifest {
  name: string
  version: string
  depends: string[]
  data: string[]
  installable: boolean
  summary: string
  category: string
  application: boolean
}

export interface OdooModule {
  name: string
  path: string
  /** The addons path it came from, usually a cloned repository. */
  repo: string
  manifest: OdooManifest
}

/** Reads and parses `__manifest__.py` (or the legacy `__openerp__.py`). */
export async function readManifest(directory: string): Promise<OdooManifest | undefined> {
  for (const file of ["__manifest__.py", "__openerp__.py"]) {
    const text = await readFile(join(directory, file), "utf8").catch(() => "")
    if (text !== "") return parseManifest(text)
  }
  return undefined
}

/** Parses the flat Python literal a manifest uses, without evaluating it. */
export function parseManifest(text: string): OdooManifest {
  const value = (key: string) => new RegExp(`["']${key}["']\\s*:\\s*["']([^"']*)["']`).exec(text)?.[1] ?? ""
  const list = (key: string) => {
    const block = new RegExp(`["']${key}["']\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(text)?.[1] ?? ""
    return [...block.matchAll(/["']([^"']+)["']/g)].flatMap((match) => (match[1] ? [match[1]] : []))
  }
  return {
    name: value("name"),
    version: value("version"),
    depends: list("depends"),
    data: list("data"),
    installable: !/["']installable["']\s*:\s*False/.test(text),
    summary: value("summary"),
    category: value("category"),
    application: /["']application["']\s*:\s*True/.test(text),
  }
}

/** Every addon under the given addons paths, sorted by technical name. */
export async function scanModules(addonsPaths: string[]): Promise<OdooModule[]> {
  const modules: OdooModule[] = []
  for (const root of addonsPaths) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue
      const path = join(root, entry.name)
      const manifest = await readManifest(path)
      if (manifest) modules.push({ name: entry.name, path, repo: basename(root), manifest })
    }
  }
  return modules.sort((a, b) => a.name.localeCompare(b.name))
}
