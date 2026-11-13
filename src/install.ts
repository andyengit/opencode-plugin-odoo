import { spawn } from "node:child_process"
import { access, appendFile, mkdir, readFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const OUTPUT_LIMIT = 2400

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-OUTPUT_LIMIT)
    }
    child.stdout.on("data", append)
    child.stderr.on("data", append)
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) return resolve(output)
      reject(new Error(`${file} ${args.join(" ")} (exit ${code})\n${output}`))
    })
  })
}

async function which(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const found = (await run("/usr/bin/which", [name], env)).trim()
    return found || undefined
  } catch {
    return undefined
  }
}

function buildEnv(): NodeJS.ProcessEnv {
  const prefix = process.env.HOMEBREW_PREFIX ?? "/opt/homebrew"
  return {
    ...process.env,
    PATH: `${prefix}/opt/libpq/bin:${prefix}/bin:/usr/local/bin:${process.env.PATH ?? "/usr/bin:/bin"}`,
    CPPFLAGS: `-I${prefix}/opt/openldap/include -I${prefix}/opt/openssl@3/include`,
    LDFLAGS: `-L${prefix}/opt/openldap/lib -L${prefix}/opt/openssl@3/lib`,
    PKG_CONFIG_PATH: `${prefix}/opt/libpq/lib/pkgconfig:${prefix}/lib/pkgconfig`,
  }
}

async function findUv(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const path of [join(homedir(), ".local/bin/uv"), join(homedir(), ".cargo/bin/uv")]) {
    if (await exists(path)) return path
  }
  return which("uv", env)
}

async function findPython(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = [
    "/opt/homebrew/bin/python3.12",
    "/usr/local/bin/python3.12",
    "/opt/homebrew/bin/python3.13",
    "/usr/local/bin/python3.13",
    "/opt/homebrew/bin/python3.11",
    "/usr/local/bin/python3.11",
  ]
  for (const path of candidates) {
    if (await exists(path)) return path
  }
  return which("python3.12", env) ?? which("python3.11", env) ?? which("python3.10", env)
}

/**
 * Builds the command that installs packages into a virtualenv: its own `bin/pip`, or `uv pip install`
 * because a venv created with `uv venv` ships no pip at all.
 */
export async function pipInstall(venv: string, args: string[]): Promise<{ file: string; args: string[] } | undefined> {
  const pip = join(venv, "bin", "pip")
  if (await exists(pip)) return { file: pip, args: ["install", ...args] }
  const python = join(venv, "bin", "python")
  if (!(await exists(python))) return undefined
  const uv = await findUv(buildEnv())
  if (uv) return { file: uv, args: ["pip", "install", "--python", python, ...args] }
  return undefined
}

async function ensureGitignore(directory: string): Promise<void> {
  const file = join(directory, ".gitignore")
  const current = await readFile(file, "utf8").catch(() => "")
  const lines = current.split("\n").map((line) => line.trim())
  const missing = ["/bin/", "/odoo/"].filter((entry) => !lines.includes(entry))
  if (missing.length === 0) return
  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
  await appendFile(file, prefix + missing.join("\n") + "\n")
}

export type InstallStep = "clone" | "venv" | "requirements" | "done"

export async function installOdoo(
  directory: string,
  version: string,
  onStep: (step: InstallStep) => void = () => undefined,
): Promise<string> {
  const env = buildEnv()
  const major = version.split(".")[0] || version
  const name = `odoo-${major}`
  const target = join(directory, "bin", name)
  await mkdir(join(directory, "bin"), { recursive: true })

  if (!(await exists(join(target, "odoo-bin")))) {
    onStep("clone")
    await run(
      "git",
      ["clone", "--depth", "1", "--branch", version, "https://github.com/odoo/odoo.git", target],
      env,
    ).catch(async (primary: unknown) => {
      await rm(target, { recursive: true, force: true })
      try {
        await run(
          "git",
          ["clone", "--depth", "1", "--branch", "master", "https://github.com/odoo/odoo.git", target],
          env,
        )
      } catch {
        throw primary
      }
    })
  }

  onStep("venv")
  const venv = join(target, ".venv")
  const uv = await findUv(env)
  if (!(await exists(join(venv, "bin", "python")))) {
    if (uv) {
      await run(uv, ["venv", venv, "--python", "3.12"], env)
    } else {
      const python = await findPython(env)
      if (!python) throw new Error("Python >= 3.10 not found (install python@3.12 or uv)")
      await run(python, ["-m", "venv", venv], env)
    }
  }

  onStep("requirements")
  const requirements = join(target, "requirements.txt")
  if (uv) {
    await run(uv, ["pip", "install", "--python", join(venv, "bin", "python"), "-r", requirements], env)
  } else {
    const pip = join(venv, "bin", "pip")
    await run(pip, ["install", "--upgrade", "pip", "setuptools", "wheel"], env)
    await run(pip, ["install", "-r", requirements], env)
  }

  // Extra packages the user keeps for this workspace survive a fresh install.
  const local = join(directory, "requirements-local.txt")
  if (await exists(local)) {
    if (uv) {
      await run(uv, ["pip", "install", "--python", join(venv, "bin", "python"), "-r", local], env)
    } else {
      await run(join(venv, "bin", "pip"), ["install", "-r", local], env)
    }
  }

  await ensureGitignore(directory)
  onStep("done")
  return `Installed Odoo ${version} in bin/${name} (its own .venv)`
}
