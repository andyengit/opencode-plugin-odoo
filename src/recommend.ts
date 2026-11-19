import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { getAddonsPath, parseOdooConfig } from "./config"
import { environmentLaunchCommand } from "./odoo"
import { virtualSkill, type SkillFile } from "./skills"
import type { OdooEnvironment, OdooWorkspace } from "./workspace"

export interface OdooRecommendation {
  source?: string
  baseCommand?: string
  toolReadme?: string
  addonsPath: string[]
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/

function shellToken(value: string): string {
  if (SHELL_SAFE.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function activeEnvironment(workspace: OdooWorkspace): OdooEnvironment | undefined {
  return workspace.environments.find((environment) => environment.active) ?? workspace.environments[0]
}

async function readable(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined
  const info = await stat(path).catch(() => undefined)
  return info?.isFile() && info.size > 0 ? path : undefined
}

/**
 * Turns the detected workspace into the variables the Odoo skills look for, so the agent can read
 * the real framework source and reuse the workspace launch command instead of guessing.
 */
export async function recommend(workspace: OdooWorkspace): Promise<OdooRecommendation> {
  const environment = activeEnvironment(workspace)
  const text = environment ? await readFile(environment.confPath, "utf8").catch(() => "") : ""
  const addonsPath = getAddonsPath(parseOdooConfig(text))
  const source = environment?.binPath
    ? environment.binPath.replace(/\/odoo-bin$/, "")
    : workspace.versions[0]?.directory
  const baseCommand =
    environment && environment.binPath && environment.confPath
      ? environmentLaunchCommand(workspace, environment).map(shellToken).join(" ")
      : undefined
  const toolReadme = await readable(join(workspace.root, "README.md"))
  return {
    ...(source ? { source } : {}),
    ...(baseCommand ? { baseCommand } : {}),
    ...(toolReadme ? { toolReadme } : {}),
    addonsPath,
  }
}

export interface AppliedEnvironment {
  applied: string[]
  kept: string[]
}

/** Values this process exported, so a workspace switch can replace them without touching user exports. */
const registry = globalThis as typeof globalThis & { __odooRecommended?: Map<string, string> }
const owned = (registry.__odooRecommended ??= new Map<string, string>())

/**
 * Exports the recommendation for shell commands. A variable the user set themselves is kept; one the
 * plugin set for a previous workspace is replaced so the shell always matches the open project.
 */
export function applyRecommendation(
  recommendation: OdooRecommendation,
  options: { force?: boolean } = {},
): AppliedEnvironment {
  const values: Record<string, string | undefined> = {
    ODOO_SOURCE: recommendation.source,
    ODOO_BASE_COMMAND: recommendation.baseCommand,
    ODOO_TOOL_README: recommendation.toolReadme,
  }
  const applied: string[] = []
  const kept: string[] = []
  for (const [key, value] of Object.entries(values)) {
    const current = process.env[key]
    const previous = owned.get(key)
    if (!options.force && current !== undefined && current !== previous) {
      kept.push(key)
      continue
    }
    if (!value) {
      if (previous !== undefined) {
        delete process.env[key]
        owned.delete(key)
      }
      continue
    }
    process.env[key] = value
    owned.set(key, value)
    applied.push(key)
  }
  return { applied, kept }
}

/** A skill with the live workspace facts, so the model always has the recommendation at hand. */
export function workspaceSkill(workspace: OdooWorkspace, recommendation: OdooRecommendation): SkillFile {
  const environment = activeEnvironment(workspace)
  const configurations =
    workspace.environments.length > 0
      ? workspace.environments.map(
          (item) => `- \`${item.label}\`${item.active ? " [active]" : ""} — Odoo \`${item.version ?? "?"}\` — \`${item.confPath}\``,
        )
      : ["- (none)"]
  const versions =
    workspace.versions.length > 0
      ? workspace.versions.map((version) => `- \`${version.name}\` (${version.series}) — \`${version.directory}\``)
      : ["- (none)"]
  const exports = [
    recommendation.source ? `export ODOO_SOURCE=${shellToken(recommendation.source)}` : undefined,
    recommendation.baseCommand ? `export ODOO_BASE_COMMAND=${shellToken(recommendation.baseCommand)}` : undefined,
    recommendation.toolReadme ? `export ODOO_TOOL_README=${shellToken(recommendation.toolReadme)}` : undefined,
  ].filter((line): line is string => line !== undefined)
  return virtualSkill({
    id: "odoo-workspace",
    name: "odoo-workspace",
    description:
      "Local Odoo workspace detected by the Odoo plugin: versions, configurations, addons paths and the recommended ODOO_SOURCE, ODOO_BASE_COMMAND and ODOO_TOOL_README values. Use before proposing Odoo commands or reading framework code in this project.",
    content: [
      "# Local Odoo workspace",
      "",
      `Root: \`${workspace.root}\``,
      environment ? `Active configuration: \`${environment.label}\` (Odoo \`${environment.version ?? "?"}\`)` : "Active configuration: (none)",
      "",
      "## Versions",
      ...versions,
      "",
      "## Configurations",
      ...configurations,
      "",
      "## Addons paths",
      ...(recommendation.addonsPath.length > 0 ? recommendation.addonsPath.map((path) => `- \`${path}\``) : ["- (none)"]),
      "",
      "## Recommended environment",
      "",
      "The plugin exports these variables for shell commands in this workspace unless you already set them:",
      "",
      "```bash",
      ...(exports.length > 0 ? exports : ["# no Odoo source or configuration detected yet"]),
      "```",
      "",
      "Read `ODOO_SOURCE` instead of guessing framework behavior, start proposed install/update/test commands from `ODOO_BASE_COMMAND`, and read `ODOO_TOOL_README` before running project-specific tooling. Ask before running commands that touch a database or a local service.",
    ].join("\n"),
  })
}
