import { spawn } from "node:child_process"

export interface RunResult {
  code: number
  output: string
}

const OUTPUT_LIMIT = 20000

/** Runs a command in a directory, feeding optional stdin, and keeps the tail of its output. */
export function runProcess(
  file: string,
  args: string[],
  options: { cwd: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let output = ""
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT)
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    const timeout = options.timeoutMs
    const timer = timeout
      ? setTimeout(() => {
          append(Buffer.from(`\n(timed out after ${Math.round(timeout / 1000)}s)`))
          child.kill("SIGTERM")
        }, timeout)
      : undefined
    child.on("error", (error) => {
      if (timer) clearTimeout(timer)
      resolve({ code: -1, output: `${output}\n${String(error)}` })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
    child.stdin.end(options.input ?? "")
  })
}
