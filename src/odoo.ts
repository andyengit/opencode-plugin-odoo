import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import type { OdooEnvironment, OdooWorkspace } from "./workspace"

export interface LaunchOptions {
  pythonPath: string
  odooBinPath: string
  confPath: string
  args?: string[]
}

export function launchCommand(options: LaunchOptions): string[] {
  return [options.pythonPath, options.odooBinPath, "-c", options.confPath, ...(options.args ?? [])]
}

/** Each Odoo version may keep its own .venv next to odoo-bin; the workspace one is the fallback. */
export function resolvePython(workspace: OdooWorkspace, environment?: OdooEnvironment): string {
  if (environment?.binPath) {
    const perVersion = join(dirname(environment.binPath), ".venv", "bin", "python")
    if (existsSync(perVersion)) return perVersion
  }
  if (workspace.venvPath) return join(workspace.venvPath, "bin", "python")
  return "python3"
}

export function environmentLaunchCommand(workspace: OdooWorkspace, environment: OdooEnvironment): string[] {
  return launchCommand({
    pythonPath: resolvePython(workspace, environment),
    odooBinPath: environment.binPath,
    confPath: environment.confPath,
    args: environment.args,
  })
}

export function environmentDebugCommand(workspace: OdooWorkspace, environment: OdooEnvironment): string[] {
  const args = environment.args.some((arg) => arg.startsWith("--dev"))
    ? environment.args
    : [...environment.args, "--dev=all"]
  return launchCommand({
    pythonPath: resolvePython(workspace, environment),
    odooBinPath: environment.binPath,
    confPath: environment.confPath,
    args,
  })
}
