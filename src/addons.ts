import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

/** Folders that already contain addons and could be added to `addons_path`: custom plus every clone. */
export async function availableAddons(root: string): Promise<string[]> {
  const paths: string[] = []
  const custom = join(root, "custom")
  if (await isDirectory(custom)) paths.push(custom)

  const repo = join(root, "repo")
  const orgs = await readdir(repo, { withFileTypes: true }).catch(() => [])
  for (const org of orgs) {
    if (!org.isDirectory()) continue
    const entries = await readdir(join(repo, org.name), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) if (entry.isDirectory()) paths.push(join(repo, org.name, entry.name))
  }

  return paths.sort()
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
