import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Odoo source directory name per configuration label, kept in the workspace so a launch uses that version. */
export type OdooVersionMap = Record<string, string>

function versionsPath(root: string): string {
  return join(root, ".odoo-run", "versions.json")
}

export function parseVersionMap(text: string): OdooVersionMap {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const map: OdooVersionMap = {}
    for (const [label, version] of Object.entries(parsed)) if (typeof version === "string") map[label] = version
    return map
  } catch {
    return {}
  }
}

export async function readVersionMap(root: string): Promise<OdooVersionMap> {
  return parseVersionMap(await readFile(versionsPath(root), "utf8").catch(() => ""))
}

export async function writeVersion(root: string, label: string, version: string): Promise<void> {
  const path = versionsPath(root)
  const map = await readVersionMap(root)
  map[label] = version
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(map, null, 2)}\n`)
}

export async function removeVersion(root: string, label: string): Promise<void> {
  const path = versionsPath(root)
  const map = await readVersionMap(root)
  if (!(label in map)) return
  delete map[label]
  if (Object.keys(map).length === 0) {
    await rm(path, { force: true })
    return
  }
  await writeFile(path, `${JSON.stringify(map, null, 2)}\n`)
}
