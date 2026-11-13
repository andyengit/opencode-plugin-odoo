import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export interface StartOptions {
  pidFile: string
  cwd?: string
  logFile?: string
  env?: NodeJS.ProcessEnv
}

export async function startProcess(command: string[], options: StartOptions): Promise<number> {
  const [file, ...args] = command
  if (!file) throw new Error("empty command")

  await mkdir(dirname(options.pidFile), { recursive: true })
  const logFd = options.logFile ? openSync(options.logFile, "a") : undefined
  const child = spawn(file, args, {
    detached: true,
    stdio: logFd !== undefined ? ["ignore", logFd, logFd] : "ignore",
    cwd: options.cwd,
    env: options.env,
  })
  if (logFd !== undefined) closeSync(logFd)

  if (child.pid === undefined) {
    child.kill()
    throw new Error("failed to capture process id")
  }

  await writeFile(options.pidFile, String(child.pid))
  child.unref()
  return child.pid
}

export async function stopProcess(pidFile: string): Promise<boolean> {
  const raw = await readFile(pidFile, "utf8").catch(() => "")
  const pid = Number(raw.trim())
  if (!pid || Number.isNaN(pid)) return false

  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      // process already gone
    }
  }

  await unlink(pidFile).catch(() => {})
  return true
}

export async function restartProcess(command: string[], options: StartOptions): Promise<number> {
  await stopProcess(options.pidFile)
  return startProcess(command, options)
}

export async function isProcessRunning(pidFile: string): Promise<boolean> {
  const raw = await readFile(pidFile, "utf8").catch(() => "")
  const pid = Number(raw.trim())
  if (!pid || Number.isNaN(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
