import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"
import { execFile } from "node:child_process"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { promisify } from "node:util"
import { getAddonsPath, getString, parseOdooConfig, serializeOdooConfig, setAddonsPath, setString } from "./src/config"
import { parseDockerCompose, postgresCommands } from "./src/docker"
import { environmentLaunchCommand } from "./src/odoo"
import { restartProcess, startProcess, stopProcess } from "./src/process"
import { createWorkspace } from "./src/scaffold"
import { installOdoo } from "./src/install"
import { scanModules, type OdooModule } from "./src/modules"
import { parseGitStatus } from "./src/git"
import { runProcess, type RunResult } from "./src/execute"
import {
  rpcCall,
  rpcConnect,
  rpcConnections,
  rpcDisconnect,
  rpcUseSaved,
  savedConnections,
  credentialsPath,
} from "./src/rpc"
import { resolveWorkspace, type OdooWorkspace } from "./src/workspace"

const execFileAsync = promisify(execFile)

function summarize(workspace: OdooWorkspace) {
  return {
    root: workspace.root,
    versions: workspace.versions.map((version) => `${version.name} (${version.series})`),
    environments: workspace.environments.map(
      (environment) => `${environment.label}${environment.active ? " [active]" : ""}`,
    ),
    dockerCompose: workspace.dockerComposePath,
    venv: workspace.venvPath,
    customDirs: workspace.customDirs,
    ocaDirs: workspace.ocaDirs,
  }
}

async function run(command: string[]): Promise<string> {
  const [file, ...args] = command
  if (!file) throw new Error("empty command")
  const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 })
  return (stdout + stderr).trim()
}

function pidPath(workspace: string, label: string): string {
  return `${workspace}/.odoo-run/${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.pid`
}

async function postgres(workspace: OdooWorkspace, action: "up" | "down" | "restart" | "status"): Promise<string> {
  if (!workspace.dockerComposePath) return "No docker-compose.yml found in this workspace"
  const compose = await readFile(workspace.dockerComposePath, "utf8")
  const service = parseDockerCompose(compose)[0]
  if (!service) return "No Postgres service found in docker-compose.yml"
  const commands = postgresCommands(workspace.dockerComposePath, service.name)
  if (action === "status") {
    const { stdout } = await execFileAsync("docker", ["compose", "-f", workspace.dockerComposePath, "ps", service.name])
    return stdout.trim() || `${service.name}: not running`
  }
  return (
    (await run(action === "up" ? commands.up : action === "down" ? commands.down : commands.restart)) ||
    `Postgres ${action} ok`
  )
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function tryRun(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }))
  // trimEnd keeps the leading space of the first `git status --porcelain` line (` M file`).
  return stdout.trimEnd()
}

function activeEnvironment(workspace: OdooWorkspace) {
  return workspace.environments.find((item) => item.active) ?? workspace.environments[0]
}

/** The addons_path of a configuration, defaulting to the active one. */
async function addonsOf(workspace: OdooWorkspace, label?: string): Promise<string[]> {
  const environment = label ? workspace.environments.find((item) => item.label === label) : activeEnvironment(workspace)
  if (!environment) return []
  const text = await readFile(environment.confPath, "utf8").catch(() => "")
  return getAddonsPath(parseOdooConfig(text))
}

async function reposOf(root: string): Promise<Array<{ path: string; branch: string; changed: number }>> {
  const base = join(root, "repo")
  const orgs = await readdir(base, { withFileTypes: true }).catch(() => [])
  const repos: Array<{ path: string; branch: string; changed: number }> = []
  for (const org of orgs) {
    if (!org.isDirectory()) continue
    const entries = await readdir(join(base, org.name), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(base, org.name, entry.name)
      if (!(await exists(join(path, ".git")))) continue
      const branch = await tryRun("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
      const status = await tryRun("git", ["-C", path, "status", "--porcelain"])
      repos.push({
        path: `${org.name}/${entry.name}`,
        branch,
        changed: status === "" ? 0 : status.split("\n").filter((line) => line.trim() !== "").length,
      })
    }
  }
  return repos.sort((a, b) => a.path.localeCompare(b.path))
}

/** Repositories the git tool can reach, named relative to the workspace root; "" is the root itself. */
async function gitReposOf(root: string): Promise<Array<{ path: string; branch: string; changed: number }>> {
  const candidates: Array<{ path: string; name: string }> = [
    { path: root, name: "" },
    { path: join(root, "custom"), name: "custom" },
  ]
  const base = join(root, "repo")
  for (const org of await readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!org.isDirectory()) continue
    for (const entry of await readdir(join(base, org.name), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) {
        candidates.push({ path: join(base, org.name, entry.name), name: `repo/${org.name}/${entry.name}` })
      }
    }
  }
  const repos = await Promise.all(
    candidates.map(async (candidate) => {
      if (!(await exists(join(candidate.path, ".git")))) return undefined
      const [branch, status] = await Promise.all([
        tryRun("git", ["-C", candidate.path, "rev-parse", "--abbrev-ref", "HEAD"]),
        tryRun("git", ["-C", candidate.path, "status", "--porcelain"]),
      ])
      return { path: candidate.name, branch, changed: parseGitStatus(status).length }
    }),
  )
  return repos.filter((repo) => repo !== undefined).sort((a, b) => a.path.localeCompare(b.path))
}

/** Runs git in one repository, returning whether it worked and its output. */
function gitIn(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return execFileAsync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    (value) => ({ ok: true, output: value.stdout.trimEnd() }),
    (error: unknown) => {
      const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
      const output = [record.stderr, record.stdout]
        .filter((value): value is string => typeof value === "string" && value.trim() !== "")
        .join("\n")
        .trim()
      return { ok: false, output: output || String(error) }
    },
  )
}

function describeModule(module: OdooModule): string {
  return [
    `${module.name} (${module.manifest.version || "no version"})`,
    `  path: ${module.path}`,
    `  repo: ${module.repo}`,
    `  category: ${module.manifest.category || "-"}${module.manifest.application ? " · application" : ""}`,
    module.manifest.summary ? `  summary: ${module.manifest.summary}` : "",
    `  depends: ${module.manifest.depends.join(", ") || "base"}`,
  ]
    .filter(Boolean)
    .join("\n")
}

async function searchAddons(paths: string[], query: string): Promise<string> {
  if (paths.length === 0) return "No addons paths configured."
  const globs = ["-g", "*.py", "-g", "*.xml", "-g", "*.js", "-g", "*.scss", "-g", "*.csv"]
  const ripgrep = await execFileAsync(
    "rg",
    ["--line-number", "--no-heading", "--color", "never", "--max-count", "4", ...globs, query, ...paths],
    { maxBuffer: 24 * 1024 * 1024 },
  ).catch((error: unknown) => error as { stdout?: string; code?: string })
  const output =
    typeof ripgrep === "object" && ripgrep !== null && "stdout" in ripgrep && typeof ripgrep.stdout === "string"
      ? ripgrep.stdout
      : ""
  if (output.trim() !== "") return output.trim().slice(0, 12000)
  if (typeof ripgrep === "object" && ripgrep !== null && "code" in ripgrep && ripgrep.code === "ENOENT") {
    const grep = await execFileAsync("grep", ["-rn", "--include=*.py", "--include=*.xml", query, ...paths], {
      maxBuffer: 24 * 1024 * 1024,
    }).catch((error: unknown) => error as { stdout?: string })
    return typeof grep.stdout === "string" && grep.stdout.trim() !== ""
      ? grep.stdout.trim().slice(0, 12000)
      : "No matches."
  }
  return "No matches."
}

function describeRun(result: RunResult): string {
  return `${result.code === 0 ? "ok" : `exit ${result.code}`}\n${result.output.trim() || "(no output)"}`
}

function json(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? ""
  return text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated)` : text
}

export default Plugin.define({
  id: "odoo",
  async setup(ctx) {
    const directory = ctx.location.directory

    await ctx.tool.transform((tools) => {
      tools.namespace({ name: "odoo", description: "Manage the Odoo workspace of this project." })

      tools.add({
        name: "detect",
        description: "Detect the Odoo workspace for the current project (versions, environments and Postgres).",
        input: Schema.Struct({}),
        execute: async () => {
          const workspace = await resolveWorkspace(directory)
          return {
            content: workspace
              ? JSON.stringify(summarize(workspace), null, 2)
              : "No Odoo workspace found for this project.",
          }
        },
      })

      tools.add({
        name: "init",
        description:
          "Initialize an Odoo workspace in the current project (docker-compose.yml, config/odoo.conf, .gitignore).",
        input: Schema.Struct({}),
        execute: async () => {
          const created = await createWorkspace(directory)
          return {
            content:
              created.length > 0
                ? `Created ${created.length} file(s) in ${directory}`
                : "Workspace already initialized",
          }
        },
      })

      tools.add({
        name: "install",
        description: "Clone Odoo source (by version) and create .venv with its requirements in the current project.",
        input: Schema.Struct({ version: Schema.String }),
        execute: async ({ version }) => ({ content: await installOdoo(directory, version) }),
      })

      tools.add({
        name: "conf_get",
        description: "Read the values of an odoo.conf file.",
        input: Schema.Struct({ confPath: Schema.String }),
        execute: async ({ confPath }) => {
          const config = parseOdooConfig(await readFile(confPath, "utf8"))
          return { content: JSON.stringify(Object.fromEntries(config.options), null, 2) }
        },
      })

      tools.add({
        name: "conf_set",
        description: "Edit a value in an odoo.conf file, then write it back.",
        input: Schema.Struct({ confPath: Schema.String, key: Schema.String, value: Schema.String }),
        execute: async ({ confPath, key, value }) => {
          const config = parseOdooConfig(await readFile(confPath, "utf8"))
          setString(config, key, value === "" ? undefined : value)
          await writeFile(confPath, serializeOdooConfig(config))
          return { content: `Set ${key} in ${confPath}` }
        },
      })

      tools.add({
        name: "addons_path_add",
        description: "Append a directory to the addons_path of an odoo.conf file.",
        input: Schema.Struct({ confPath: Schema.String, path: Schema.String }),
        execute: async ({ confPath, path }) => {
          const config = parseOdooConfig(await readFile(confPath, "utf8"))
          const paths = getAddonsPath(config)
          if (!paths.includes(path)) setAddonsPath(config, [...paths, path])
          await writeFile(confPath, serializeOdooConfig(config))
          return { content: `Updated addons_path in ${confPath}` }
        },
      })

      tools.add({
        name: "get",
        description: "Read a single scalar value from an odoo.conf file.",
        input: Schema.Struct({ confPath: Schema.String, key: Schema.String }),
        execute: async ({ confPath, key }) => {
          const config = parseOdooConfig(await readFile(confPath, "utf8"))
          return { content: getString(config, key) ?? "" }
        },
      })

      tools.add({
        name: "postgres",
        description: "Start, stop or restart this project's Postgres service through docker compose.",
        input: Schema.Struct({ action: Schema.Literals(["up", "down", "restart", "status"]) }),
        execute: async ({ action }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          return { content: await postgres(workspace, action) }
        },
      })

      tools.add({
        name: "start",
        description: "Start an Odoo environment of this project by label.",
        input: Schema.Struct({ label: Schema.String }),
        execute: async ({ label }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const environment = workspace.environments.find((item) => item.label === label)
          if (!environment) return { content: `Environment "${label}" not found in ${workspace.root}` }
          const pid = await startProcess(environmentLaunchCommand(workspace, environment), {
            pidFile: pidPath(workspace.root, label),
            cwd: workspace.root,
          })
          return { content: `Started ${label} (pid ${pid})` }
        },
      })

      tools.add({
        name: "stop",
        description: "Stop a running Odoo environment of this project by label.",
        input: Schema.Struct({ label: Schema.String }),
        execute: async ({ label }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const stopped = await stopProcess(pidPath(workspace.root, label))
          return { content: stopped ? `Stopped ${label}` : `No running process found for ${label}` }
        },
      })

      tools.add({
        name: "restart",
        description: "Restart an Odoo environment of this project by label.",
        input: Schema.Struct({ label: Schema.String }),
        execute: async ({ label }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const environment = workspace.environments.find((item) => item.label === label)
          if (!environment) return { content: `Environment "${label}" not found in ${workspace.root}` }
          const pid = await restartProcess(environmentLaunchCommand(workspace, environment), {
            pidFile: pidPath(workspace.root, label),
            cwd: workspace.root,
          })
          return { content: `Restarted ${label} (pid ${pid})` }
        },
      })

      tools.add({
        name: "context",
        description:
          "Summarize the Odoo workspace for orientation: versions, configurations, active addons_path, cloned repositories and the latest log errors.",
        input: Schema.Struct({}),
        execute: async () => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const active = activeEnvironment(workspace)
          const paths = await addonsOf(workspace)
          const modules = await scanModules(paths)
          const repos = await reposOf(workspace.root)
          const logName = (active?.label ?? "odoo").replace(/[^a-zA-Z0-9_-]/g, "_")
          const log = await readFile(join(workspace.root, ".odoo-run", `${logName}.log`), "utf8").catch(() => "")
          const errors = log
            .split("\n")
            .filter((line) => line.includes(" ERROR ") || line.includes(" CRITICAL "))
            .slice(-8)
          const configurations = workspace.environments.map((environment) => {
            const suffix = environment.active ? " [active]" : ""
            return `- ${environment.label}${suffix} version=${environment.version ?? "?"} conf=${environment.confPath}`
          })
          return {
            content: [
              `Workspace: ${workspace.root}`,
              `Versions: ${workspace.versions.map((version) => `${version.name} (${version.series})`).join(", ") || "none"}`,
              `Configurations (${configurations.length}):`,
              ...configurations,
              `Active addons paths (${paths.length}):`,
              ...paths.slice(0, 30).map((path) => `- ${path}`),
              `Modules: ${modules.length}`,
              `Repositories (${repos.length}):`,
              ...repos.map((repo) => `- ${repo.path} branch=${repo.branch} changed=${repo.changed}`),
              `Last log errors:`,
              ...(errors.length > 0 ? errors : ["(none)"]),
            ].join("\n"),
          }
        },
      })

      tools.add({
        name: "modules",
        description:
          "List the Odoo addons available in a configuration's addons_path (default: the active one), with version and repository.",
        input: Schema.Struct({ conf: Schema.optional(Schema.String), filter: Schema.optional(Schema.String) }),
        execute: async ({ conf, filter }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const paths = await addonsOf(workspace, conf)
          if (paths.length === 0) return { content: "No addons_path configured for that configuration." }
          const modules = await scanModules(paths)
          const query = (filter ?? "").toLowerCase()
          const filtered =
            query === ""
              ? modules
              : modules.filter(
                  (module) =>
                    module.name.toLowerCase().includes(query) || module.manifest.name.toLowerCase().includes(query),
                )
          const lines = filtered
            .slice(0, 300)
            .map(
              (module) =>
                `${module.name}\t${module.manifest.version || "-"}\t${module.repo}${module.manifest.installable ? "" : "\tnot installable"}`,
            )
          const more = filtered.length > 300 ? `\n… ${filtered.length - 300} more` : ""
          return {
            content:
              [`${filtered.length} modules in ${paths.length} addons paths`, "name\tversion\trepo", ...lines].join(
                "\n",
              ) + more,
          }
        },
      })

      tools.add({
        name: "module",
        description:
          "Describe an Odoo addon: manifest, dependencies, which modules depend on it, model files and data files.",
        input: Schema.Struct({ name: Schema.String, conf: Schema.optional(Schema.String) }),
        execute: async ({ name, conf }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const paths = await addonsOf(workspace, conf)
          const modules = await scanModules(paths)
          const module = modules.find((item) => item.name === name)
          if (!module) return { content: `Module "${name}" not found in the addons_path.` }
          const dependents = modules.filter((item) => item.manifest.depends.includes(name)).map((item) => item.name)
          const models = (await readdir(join(module.path, "models"), { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
            .map((entry) => entry.name)
          const security = (await exists(join(module.path, "security", "ir.model.access.csv"))) ? "yes" : "no"
          return {
            content: [
              describeModule(module),
              `  models: ${models.join(", ") || "-"}`,
              `  data files: ${module.manifest.data.length}${module.manifest.data.length > 0 ? ` (${module.manifest.data.slice(0, 8).join(", ")}${module.manifest.data.length > 8 ? ", …" : ""})` : ""}`,
              `  security/ir.model.access.csv: ${security}`,
              `  required by: ${dependents.join(", ") || "no module in this workspace"}`,
            ].join("\n"),
          }
        },
      })

      tools.add({
        name: "search",
        description:
          "Search code inside the active addons_path (Python, XML, JS, SCSS and CSV), returning file:line matches.",
        input: Schema.Struct({ query: Schema.String, conf: Schema.optional(Schema.String) }),
        execute: async ({ query, conf }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          return { content: await searchAddons(await addonsOf(workspace, conf), query) }
        },
      })

      tools.add({
        name: "update",
        description:
          "Update (or install with install=true) Odoo modules in a database using the configuration's odoo-bin and --stop-after-init.",
        input: Schema.Struct({
          database: Schema.String,
          modules: Schema.optional(Schema.String),
          install: Schema.optional(Schema.Boolean),
          conf: Schema.optional(Schema.String),
        }),
        execute: async ({ database, modules, install, conf }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const environment = conf
            ? workspace.environments.find((item) => item.label === conf)
            : activeEnvironment(workspace)
          if (!environment) return { content: "Configuration not found." }
          const [python, bin] = environmentLaunchCommand(workspace, environment)
          if (!python || !bin) return { content: "Could not resolve the Odoo launch command." }
          const list = (modules ?? "base").trim() || "base"
          const result = await runProcess(
            python,
            [bin, "-c", environment.confPath, "-d", database, install ? "-i" : "-u", list, "--stop-after-init"],
            { cwd: workspace.root, timeoutMs: 30 * 60 * 1000 },
          )
          return { content: describeRun(result) }
        },
      })

      tools.add({
        name: "shell",
        description: "Run a Python script in the Odoo shell of a database and return its output.",
        input: Schema.Struct({
          database: Schema.String,
          script: Schema.String,
          conf: Schema.optional(Schema.String),
        }),
        execute: async ({ database, script, conf }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const environment = conf
            ? workspace.environments.find((item) => item.label === conf)
            : activeEnvironment(workspace)
          if (!environment) return { content: "Configuration not found." }
          const [python, bin] = environmentLaunchCommand(workspace, environment)
          if (!python || !bin) return { content: "Could not resolve the Odoo launch command." }
          const result = await runProcess(
            python,
            [bin, "shell", "-c", environment.confPath, "-d", database, "--log-level=warn"],
            { cwd: workspace.root, input: script, timeoutMs: 5 * 60 * 1000 },
          )
          return { content: describeRun(result) }
        },
      })

      tools.add({
        name: "exec",
        description:
          "Run a shell command in the Odoo workspace root (git, pip, docker compose, psql…) and return its last output.",
        input: Schema.Struct({ command: Schema.String, timeout: Schema.optional(Schema.Number) }),
        execute: async ({ command, timeout }) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          const seconds = Math.min(Math.max(timeout ?? 120, 1), 3600)
          const result = await runProcess("/bin/sh", ["-lc", command], {
            cwd: workspace.root,
            timeoutMs: seconds * 1000,
          })
          return { content: describeRun(result) }
        },
      })

      tools.add({
        name: "git",
        description:
          "Inspect and change git in this workspace. Read status and diff first, then stage only the files the user wants and commit with a message you write from the staged diff. Also switches or creates branches and manages the stash.",
        input: Schema.Struct({
          action: Schema.Literals([
            "repos",
            "status",
            "diff",
            "stage",
            "unstage",
            "commit",
            "checkout",
            "create-branch",
            "stash",
          ]),
          repository: Schema.optional(Schema.String),
          paths: Schema.optional(Schema.Array(Schema.String)),
          message: Schema.optional(Schema.String),
          staged: Schema.optional(Schema.Boolean),
          branch: Schema.optional(Schema.String),
          base: Schema.optional(Schema.String),
          stash: Schema.optional(Schema.Literals(["push", "pop", "apply", "drop"])),
          index: Schema.optional(Schema.Number),
        }),
        execute: async (input) => {
          const workspace = await resolveWorkspace(directory)
          if (!workspace) return { content: "No Odoo workspace found for this project." }
          if (input.action === "repos") return { content: json(await gitReposOf(workspace.root)) }

          const path = input.repository ? resolve(workspace.root, input.repository) : workspace.root
          if (path !== workspace.root && !path.startsWith(`${workspace.root}${sep}`)) {
            return { content: "That repository is outside the workspace." }
          }
          const name = input.repository || "."
          if (!(await exists(join(path, ".git")))) {
            return { content: `${name} is not a git repository. Use action "repos" to list them.` }
          }

          if (input.action === "status") {
            const [branch, status, stash] = await Promise.all([
              gitIn(path, ["rev-parse", "--abbrev-ref", "HEAD"]),
              gitIn(path, ["status", "--porcelain"]),
              gitIn(path, ["stash", "list", "--format=%gd%x09%s"]),
            ])
            return {
              content: json({
                repository: name,
                branch: branch.output,
                files: parseGitStatus(status.output),
                stash: stash.output,
              }),
            }
          }

          if (input.action === "diff") {
            const diff = await gitIn(path, input.staged ? ["diff", "--staged"] : ["diff"])
            return { content: diff.output.slice(0, 20000) || "No changes." }
          }

          if (input.action === "stage" || input.action === "unstage") {
            const paths = input.paths ?? []
            const args =
              input.action === "stage"
                ? paths.length === 0
                  ? ["add", "-A", "."]
                  : ["add", "--", ...paths]
                : paths.length === 0
                  ? ["restore", "--staged", "."]
                  : ["restore", "--staged", "--", ...paths]
            const result = await gitIn(path, args)
            return { content: result.ok ? (input.action === "stage" ? "Staged" : "Unstaged") : result.output }
          }

          if (input.action === "commit") {
            const message = (input.message ?? "").trim()
            if (message === "") return { content: "Write the commit message in `message`." }
            const result = await gitIn(path, ["commit", "-m", message])
            return { content: result.ok ? `Committed in ${name}\n${result.output}` : result.output }
          }

          if (input.action === "checkout") {
            const branch = input.branch ?? ""
            if (branch === "") return { content: "Pass `branch` to check out." }
            const result = await gitIn(path, ["checkout", branch])
            return { content: result.ok ? `On ${branch}` : result.output }
          }

          if (input.action === "create-branch") {
            const branch = input.branch ?? ""
            if (branch === "") return { content: "Pass `branch` with the new branch name." }
            const result = await gitIn(path, ["checkout", "-b", branch, input.base || "HEAD"])
            return { content: result.ok ? `On ${branch}` : result.output }
          }

          const stash = input.stash ?? "push"
          const reference = `stash@{${input.index ?? 0}}`
          const message = (input.message ?? "").trim()
          const args =
            stash === "push"
              ? message === ""
                ? ["stash", "push"]
                : ["stash", "push", "-m", message]
              : stash === "pop"
                ? ["stash", "pop", reference]
                : stash === "apply"
                  ? ["stash", "apply", reference]
                  : ["stash", "drop", reference]
          const result = await gitIn(path, args)
          return { content: result.ok ? `Stash ${stash} done` : result.output }
        },
      })

      tools.add({
        name: "rpc_connect",
        description:
          "Connect to an Odoo server over XML-RPC. Ask the user for the URL, database, username and password or API key; never invent them. Credentials stay in server memory, are not written to disk and are not echoed back.",
        input: Schema.Struct({
          url: Schema.String,
          database: Schema.String,
          username: Schema.String,
          password: Schema.String,
          name: Schema.optional(Schema.String),
          writes: Schema.optional(Schema.Boolean),
        }),
        execute: async ({ url, database, username, password, name, writes }) => {
          try {
            return { content: json(await rpcConnect({ url, database, username, password, name, writes })) }
          } catch (error) {
            return { content: `Error: ${String(error)}` }
          }
        },
      })

      tools.add({
        name: "rpc_saved",
        description:
          "List the XML-RPC connections the user saved in ~/.config/opencode/odoo-rpc.json (names, URLs, databases and users; never the passwords).",
        input: Schema.Struct({}),
        execute: async () => {
          const saved = await savedConnections()
          if (saved.length === 0) {
            return {
              content: [
                `No saved connections. Create ${credentialsPath()} with:`,
                `{`,
                `  "prod": {`,
                `    "url": "https://odoo.example.com",`,
                `    "database": "produccion",`,
                `    "username": "admin",`,
                `    "password": "API-KEY",`,
                `    "enabled": true,`,
                `    "writes": false`,
                `  }`,
                `}`,
                `Then run: chmod 600 ${credentialsPath()}`,
              ].join("\n"),
            }
          }
          return { content: json(saved) }
        },
      })

      tools.add({
        name: "rpc_use",
        description:
          "Open an XML-RPC connection with the credentials saved under that name in ~/.config/opencode/odoo-rpc.json. The password never passes through the chat.",
        input: Schema.Struct({ name: Schema.String }),
        execute: async ({ name }) => {
          try {
            return { content: json(await rpcUseSaved(name)) }
          } catch (error) {
            return { content: `Error: ${String(error)}` }
          }
        },
      })

      tools.add({
        name: "rpc_connections",
        description: "List the open XML-RPC connections (names, URLs, databases and uids; never the passwords).",
        input: Schema.Struct({}),
        execute: async () => ({ content: json(rpcConnections()) }),
      })

      tools.add({
        name: "rpc_call",
        description:
          "Call any Odoo model method over XML-RPC (execute_kw), e.g. search_read, read, create, write, unlink, or a model action. Use a saved connection name so credentials stay out of the chat. Confirm destructive calls with the user first.",
        input: Schema.Struct({
          connection: Schema.optional(Schema.String),
          model: Schema.String,
          method: Schema.String,
          args: Schema.optional(Schema.Array(Schema.Unknown)),
          kwargs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        execute: async ({ connection, model, method, args, kwargs }) => {
          try {
            return { content: json(await rpcCall(connection, model, method, args ?? [], kwargs ?? {})) }
          } catch (error) {
            return { content: `Error: ${String(error)}` }
          }
        },
      })

      tools.add({
        name: "rpc_search_read",
        description:
          "Read records over XML-RPC with search_read: model, optional domain, fields, limit, offset and order. Use a saved connection name so credentials stay out of the chat; it is the quickest way to inspect production data.",
        input: Schema.Struct({
          connection: Schema.optional(Schema.String),
          model: Schema.String,
          domain: Schema.optional(Schema.Array(Schema.Unknown)),
          fields: Schema.optional(Schema.Array(Schema.String)),
          limit: Schema.optional(Schema.Number),
          offset: Schema.optional(Schema.Number),
          order: Schema.optional(Schema.String),
        }),
        execute: async ({ connection, model, domain, fields, limit, offset, order }) => {
          try {
            const kwargs: Record<string, unknown> = {}
            if (fields) kwargs.fields = fields
            if (limit !== undefined && limit !== null) kwargs.limit = limit
            if (offset !== undefined && offset !== null) kwargs.offset = offset
            if (order) kwargs.order = order
            return { content: json(await rpcCall(connection, model, "search_read", [domain ?? []], kwargs)) }
          } catch (error) {
            return { content: `Error: ${String(error)}` }
          }
        },
      })

      tools.add({
        name: "rpc_disconnect",
        description: "Close an XML-RPC connection and forget its credentials.",
        input: Schema.Struct({ connection: Schema.String }),
        execute: async ({ connection }) => ({
          content: rpcDisconnect(connection) ? `Disconnected ${connection}` : `No connection named ${connection}`,
        }),
      })
    })
  },
})
