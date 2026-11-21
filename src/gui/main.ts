import { execFile, spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { access, chmod, cp, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { Readable } from "node:stream"
import { promisify } from "node:util"
import { Schema } from "effect"
import type { Plugin } from "@opencode/plugin/gui/main"
import { CLI_MARKER, cliDispatcher, cliLauncher, cliState } from "../cli"
import { parseDatabases, parseModules, quoteIdentifier, safeDatabaseName } from "../database"
import { isConfKey } from "./fields"
import { parseProcesses } from "../ps"
import { parseComposePs, parseDockerCompose, postgresCommands, postgresStatus } from "../docker"
import {
  applyConfigLines,
  getAddonsPath,
  getString,
  parseOdooConfig,
  setAddonsPathText,
  setEntryText,
} from "../config"
import { environmentLaunchCommand } from "../odoo"
import { isProcessRunning, restartProcess, runningPid, startProcess, stopProcess } from "../process"
import { resolveWorkspace, type OdooEnvironment, type OdooWorkspace } from "../workspace"
import { createWorkspace, createConf, confLabel, reconfigureWorkspace } from "../scaffold"
import { installOdoo, pipInstall, type InstallStep } from "../install"
import { installSkillPack, skillPackStatus } from "../skillpack"
import { addFolderToAddons, cloneRepository, isAuthFailure, sshFallback } from "../clone"
import { inspectRepositories, reposUpdateLogPath, updateRepositories } from "../reposUpdate"
import { preCommitInfo, repositoryDigest, runPreCommit, setupPreCommit } from "../precommit"
import { parseAheadBehind, parseGitBranches, parseGitLog, parseGitNumstat, parseGitStash, parseGitStatus } from "../git"
import { removeVersion, readVersionMap, writeVersion } from "../versions"
import { mergeRepos, parseEnvironmentRepos, repoFolder, sameCommit, sshUrl } from "../repos"
import { missingRequirements, parseRequirements } from "../requirements"
import { availableAddons } from "../addons"
import { databaseName, parsePull, pullFailed, pullReady } from "../rebuild"
import { credentialsPath, parseSavedConnections } from "../rpc"
import {
  apiDownload,
  apiGet,
  apiPost,
  environmentDatabase,
  normalizeItems,
  parseProfile,
  pollDevice,
  refreshTokens,
  requestDevice,
  revokeToken,
  type AdooDevice,
} from "../adoo"
import {
  Odoo,
  type AdooData,
  type AdooStatus,
  type AddonsState,
  type RebuildStatus,
  type WorkspaceStatus,
  type WorkspaceSummary,
} from "./contract"

const AdooTokensSchema = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Number,
  scope: Schema.String,
})

const AdooProfileSchema = Schema.Struct({
  sub: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
})

interface AdooPending {
  cancelled: boolean
  userCode: string
  verificationUri: string
  state: "pending" | "denied" | "expired" | "error"
  message: string
}

type SyncRepoState = "pending" | "clone" | "pull" | "done" | "skipped" | "error"

interface SyncRepo {
  path: string
  folder: string
  url: string
  branch: string
  auth: string
  state: SyncRepoState
  message: string
}

interface SyncJob {
  running: boolean
  environment: string
  repos: SyncRepo[]
}

interface InstallJob {
  running: boolean
  version: string
  conf: string
  step: InstallStep | "error" | ""
  message: string
  startedAt: number
}

interface PythonJob {
  running: boolean
  version: string
  packages: string
  message: string
  startedAt: number
}

interface ModuleJob {
  running: boolean
  action: string
  module: string
  database: string
  message: string
  startedAt: number
}

interface RebuildJob {
  running: boolean
  environment: string
  step: RebuildStatus["step"]
  message: string
  database: string
  bytes: number
  totalBytes: number
  startedAt: number
}

const execFileAsync = promisify(execFile)

// The desktop app's main process inherits a minimal PATH (`/usr/bin:/bin:...`), so Homebrew/Docker
// tools are not found unless the PATH is widened for every child process. Computed lazily: this module
// is also evaluated in the window, where `process` is undefined, so it must not run at module scope.
function commandEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` }
}

function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("docker", args, { env: commandEnv(), maxBuffer: 16 * 1024 * 1024 })
}

/** Runs git without ever prompting: a private repository fails with its message instead of hanging. */
function git(args: string[], cwd?: string): Promise<string | undefined> {
  return execFileAsync("git", args, {
    cwd,
    env: { ...commandEnv(), GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    () => undefined,
    (error: unknown) => {
      const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
      return stderr.trim().split("\n").slice(-2).join(" ").trim() || "git failed"
    },
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Writes a file only when its contents change, so polling never rewrites it. */
async function writeIfChanged(path: string, content: string, mode: number) {
  const current = await readFile(path, "utf8").catch(() => "")
  if (current === content) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, { mode })
  await chmod(path, mode)
}

/** The repository a panel row names: an empty id is the workspace root. Only paths inside the workspace pass. */
async function gitRepository(directory: string, repository: string): Promise<string | undefined> {
  const workspace = await resolveWorkspace(directory)
  if (!workspace) return undefined
  const path = repository === "" ? workspace.root : resolve(workspace.root, repository)
  if (path !== workspace.root && !path.startsWith(`${workspace.root}${sep}`)) return undefined
  if (!(await pathExists(join(path, ".git")))) return undefined
  return path
}

/** Resolves a commit context file inside the selected repository, then the workspace. */
async function contextPath(directory: string, repository: string, file: string): Promise<string> {
  if (isAbsolute(file)) return file
  const repo = await gitRepository(directory, repository)
  const workspace = await resolveWorkspace(directory)
  const roots = [repo, workspace?.root, directory].filter(
    (root): root is string => typeof root === "string" && root !== "",
  )
  for (const root of roots) {
    const path = join(root, file)
    if (await pathExists(path)) return path
  }
  return join(roots[0] ?? directory, file)
}

/** Runs git capturing its output, empty on failure. */
function gitText(args: string[], cwd: string): Promise<string> {
  return execFileAsync("git", args, { cwd, env: commandEnv(), maxBuffer: 16 * 1024 * 1024 }).then(
    // trimEnd keeps the leading space of the first `git status --porcelain` line (` M file`).
    (result) => result.stdout.trimEnd(),
    () => "",
  )
}

/** Runs a command, returning its error text (or nothing when it succeeded). */
function command(file: string, args: string[], cwd: string): Promise<string | undefined> {
  return execFileAsync(file, args, { cwd, env: commandEnv(), maxBuffer: 32 * 1024 * 1024 }).then(
    () => undefined,
    (error: unknown) => {
      const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
      const stderr = typeof record.stderr === "string" ? record.stderr : ""
      const stdout = typeof record.stdout === "string" ? record.stdout : ""
      return (stderr.trim() || stdout.trim()).split("\n").slice(-3).join(" ").trim() || "command failed"
    },
  )
}

/** Streams a fetched response body to a file, reporting how many bytes arrived. */
function writeBody(
  response: Response,
  path: string,
  onProgress: (bytes: number, total: number) => void,
): Promise<void> {
  const body = response.body
  if (!body) return Promise.reject(new Error("The download returned no body"))
  const total = Number(response.headers.get("content-length")) || 0
  return new Promise((resolve, reject) => {
    const source = Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0])
    const target = createWriteStream(path)
    let bytes = 0
    onProgress(0, total)
    source.on("data", (chunk: Buffer) => {
      bytes += chunk.length
      onProgress(bytes, total)
    })
    source.pipe(target)
    target.on("finish", () => resolve())
    target.on("error", reject)
    source.on("error", reject)
  })
}

/** Runs a command feeding a file through its stdin. */
function commandInput(file: string, args: string[], input: string, cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env: commandEnv(), stdio: ["pipe", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on("error", (error) => resolve(String(error)))
    child.on("close", (code) => {
      const message = stderr.trim().split("\n").slice(-3).join(" ")
      resolve(code === 0 ? undefined : message || `exit ${code}`)
    })
    const stream = createReadStream(input)
    stream.on("error", (error) => {
      child.kill()
      resolve(String(error))
    })
    stream.pipe(child.stdin)
  })
}

async function findFile(directory: string, extension: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(extension)) return join(directory, entry.name)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = await findFile(join(directory, entry.name), extension)
    if (nested) return nested
  }
  return undefined
}

async function findFilestore(directory: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const direct = entries.find((entry) => entry.isDirectory() && entry.name === "filestore")
  if (!direct) return undefined
  const root = join(directory, "filestore")
  const children = await readdir(root, { withFileTypes: true }).catch(() => [])
  const child = children.find((entry) => entry.isDirectory())
  return child ? join(root, child.name) : root
}

/** Public repositories clone over HTTPS; private ones need the machine's SSH key. */
function cloneUrl(repo: SyncRepo): string {
  if (repo.auth === "public") return repo.url
  return sshUrl(repo.url) ?? repo.url
}

function summarize(workspace: OdooWorkspace): WorkspaceSummary {
  return {
    root: workspace.root,
    versions: workspace.versions.map((version) => ({ name: version.name, series: version.series })),
    environments: workspace.environments.map((environment) => environment.label),
    activeEnvironment: workspace.environments.find((environment) => environment.active)?.label ?? "",
    environmentVersion: "",
    activeHttpPort: "",
    dockerCompose: workspace.dockerComposePath ?? "",
    venv: workspace.venvPath ?? "",
  }
}

function pidFile(workspace: string, label: string): string {
  return `${workspace}/.odoo-run/${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.pid`
}

/** Reads the end of a file without loading the whole log into memory. */
async function tailFile(path: string, maxBytes = 256 * 1024): Promise<string> {
  const handle = await open(path, "r").catch(() => undefined)
  if (!handle) return ""
  try {
    const info = await handle.stat()
    const start = Math.max(0, info.size - maxBytes)
    const length = info.size - start
    if (length === 0) return ""
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return buffer.toString("utf8")
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** The log Odoo writes for a configuration: its `logfile` option, else the runner's output file. */
async function logFileFor(workspace: OdooWorkspace, environment: OdooEnvironment | undefined, label: string) {
  const conf = environment ? await readFile(environment.confPath, "utf8").catch(() => "") : ""
  const configured = getString(parseOdooConfig(conf), "logfile") ?? ""
  const fallbackName = (environment?.label ?? label).replace(/[^a-zA-Z0-9_-]/g, "_")
  const fallback = `${workspace.root}/.odoo-run/${fallbackName}.log`
  if (configured === "" || /^(none|false)$/i.test(configured)) return fallback
  const path = isAbsolute(configured) ? configured : join(workspace.root, configured)
  return (await pathExists(path)) ? path : fallback
}

/** Adds (or replaces) an attach configuration in the workspace's `.vscode/launch.json`. */
async function writeLaunchConfig(root: string): Promise<void> {
  const file = join(root, ".vscode", "launch.json")
  const current = await readFile(file, "utf8").catch(() => "")
  let parsed: Record<string, unknown> = { version: "0.2.0", configurations: [] }
  if (current !== "") {
    try {
      const value: unknown = JSON.parse(current)
      if (typeof value === "object" && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>
      else return
    } catch {
      return
    }
  }
  const configurations = Array.isArray(parsed.configurations) ? [...parsed.configurations] : []
  const attach = {
    name: "Odoo: attach",
    type: "debugpy",
    request: "attach",
    connect: { host: "127.0.0.1", port: 5678 },
    justMyCode: true,
  }
  const index = configurations.findIndex(
    (item) => typeof item === "object" && item !== null && (item as Record<string, unknown>).name === attach.name,
  )
  if (index === -1) configurations.push(attach)
  else configurations[index] = attach
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...parsed, version: "0.2.0", configurations }, null, 2)}\n`)
}

/** An `odoo.conf` value as the panel shows it. */
function configValueText(value: string | boolean | string[]): string {
  if (Array.isArray(value)) return value.join(",")
  return typeof value === "boolean" ? (value ? "True" : "False") : value
}

/** The `major.minor` Python of a virtualenv, empty when it has none. */
async function venvPythonVersion(venv: string): Promise<string> {
  return execFileAsync(
    join(venv, "bin", "python"),
    ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"],
    { env: commandEnv(), maxBuffer: 1024 * 1024 },
  ).then(
    (result) => result.stdout.trim(),
    () => "",
  )
}

interface PostgresLogin {
  compose: string
  service: string
  user: string
}

async function postgresLogin(workspace: OdooWorkspace): Promise<PostgresLogin | undefined> {
  if (!workspace.dockerComposePath) return undefined
  const text = await readFile(workspace.dockerComposePath, "utf8").catch(() => "")
  const service = parseDockerCompose(text)[0]
  if (!service) return undefined
  const user = /POSTGRES_USER:\s*([^\s#]+)/.exec(text)?.[1] ?? "odoo"
  return { compose: workspace.dockerComposePath, service: service.name, user }
}

/** Runs one SQL statement in a database through the compose Postgres service. */
async function runSql(
  workspace: OdooWorkspace,
  database: string,
  sql: string,
): Promise<{ ok: boolean; stdout: string; error: string }> {
  const login = await postgresLogin(workspace)
  if (!login) return { ok: false, stdout: "", error: "No Postgres service found in docker-compose.yml" }
  const result = await execFileAsync(
    "docker",
    [
      "compose",
      "-f",
      login.compose,
      "exec",
      "-T",
      login.service,
      "psql",
      "-U",
      login.user,
      "-d",
      database,
      "-At",
      "-F",
      "\t",
      "-c",
      sql,
    ],
    { env: commandEnv(), maxBuffer: 16 * 1024 * 1024 },
  ).then(
    (value) => ({ ok: true, stdout: value.stdout, error: "" }),
    (error: unknown) => {
      const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
      return {
        ok: false,
        stdout: typeof record.stdout === "string" ? record.stdout : "",
        error: typeof record.stderr === "string" ? record.stderr.trim() : String(error),
      }
    },
  )
  return result
}

/** Runs a command writing its stdout into a file; resolves with the failure text, if any. */
function commandToFile(args: string[], target: string): Promise<string | undefined> {
  const [file, ...rest] = args
  if (!file) return Promise.resolve("empty command")
  return new Promise((resolve) => {
    const child = spawn(file, rest, { env: commandEnv(), stdio: ["ignore", "pipe", "pipe"] })
    const output = createWriteStream(target)
    child.stdout.pipe(output)
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on("error", (error) => {
      output.close()
      resolve(String(error))
    })
    child.on("close", (code) => {
      output.close()
      resolve(code === 0 ? undefined : stderr.trim() || `exit ${code}`)
    })
  })
}

/** Runs a command feeding a file through its stdin; resolves with the failure text, if any. */
function commandFromFile(args: string[], source: string): Promise<string | undefined> {
  const [file, ...rest] = args
  if (!file) return Promise.resolve("empty command")
  return new Promise((resolve) => {
    const child = spawn(file, rest, { env: commandEnv(), stdio: [createReadStream(source), "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000)
    })
    child.on("error", (error) => resolve(String(error)))
    child.on("close", (code) => resolve(code === 0 ? undefined : stderr.trim() || `exit ${code}`))
  })
}

async function postgresState(workspace: OdooWorkspace): Promise<WorkspaceStatus["postgres"]> {
  if (!workspace.dockerComposePath) return "none"
  const service = parseDockerCompose(await readFile(workspace.dockerComposePath, "utf8"))[0]
  if (!service) return "none"
  const stdout = await docker(["compose", "-f", workspace.dockerComposePath, "ps", "--format", "json"]).then(
    (result) => result.stdout,
    () => "",
  )
  return postgresStatus(parseComposePs(stdout), service.name)
}

async function workspaceStatus(workspace: OdooWorkspace): Promise<WorkspaceStatus> {
  const environments = await Promise.all(
    workspace.environments.map(async (environment) => {
      const pid = await runningPid(pidFile(workspace.root, environment.label))
      const text = await readFile(environment.confPath, "utf8").catch(() => "")
      return {
        label: environment.label,
        running: pid > 0,
        pid,
        port: getString(parseOdooConfig(text), "http_port") ?? "",
      }
    }),
  )
  return { postgres: await postgresState(workspace), environments }
}

const setup: Plugin.MainSetup = (ctx) => {
  const selected = ctx.storage.store("selectedEnv", {
    schema: Schema.Record(Schema.String, Schema.String),
    initial: {},
  })
  const adooTokens = ctx.storage.store("adoo:tokens", {
    schema: Schema.NullOr(AdooTokensSchema),
    initial: null,
  })
  const adooProfile = ctx.storage.store("adoo:profile", {
    schema: Schema.NullOr(AdooProfileSchema),
    initial: null,
  })
  const addonsKnown = ctx.storage.store("addonsKnown", {
    schema: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    initial: {},
  })
  const commitContext = ctx.storage.store("gitCommitContext", {
    schema: Schema.Record(Schema.String, Schema.Struct({ text: Schema.String, file: Schema.String })),
    initial: {},
  })
  const started = new Set<number>()

  let adooPending: AdooPending | undefined
  let syncJob: SyncJob | undefined
  let installJob: InstallJob | undefined
  let pythonJob: PythonJob | undefined
  let rebuildJob: RebuildJob | undefined
  let moduleJob: ModuleJob | undefined
  const preCommitLast = new Map<
    string,
    { state: "passed" | "failed"; at: number; digest: string; scope: "staged" | "all" }
  >()

  const adooStatus = (): AdooStatus => {
    const tokens = adooTokens.value
    const profile = adooProfile.value
    if (tokens)
      return {
        state: "connected",
        userCode: "",
        verificationUri: "",
        message: "",
        email: profile?.email ?? "",
        name: profile?.name ?? "",
        role: profile?.role ?? "",
        scope: tokens.scope,
        expiresAt: tokens.expiresAt,
      }
    return {
      state: adooPending?.state ?? "disconnected",
      userCode: adooPending?.userCode ?? "",
      verificationUri: adooPending?.verificationUri ?? "",
      message: adooPending?.message ?? "",
      email: "",
      name: "",
      role: "",
      scope: "",
      expiresAt: 0,
    }
  }

  const adooEmpty = (): AdooData => ({
    connected: false,
    forbidden: false,
    email: "",
    name: "",
    role: "",
    environments: [],
  })

  // A renewed token replaces both halves: reusing the previous refresh token revokes the whole grant.
  const renewAdoo = async (): Promise<string | undefined> => {
    const current = adooTokens.value
    if (!current) return
    const renewed = await refreshTokens(undefined, current.refreshToken).catch(() => undefined)
    if (renewed?.state !== "ok") {
      if (renewed?.state === "denied") {
        adooTokens.set(null)
        adooProfile.set(null)
      }
      return
    }
    adooTokens.set(renewed.tokens)
    return renewed.tokens.accessToken
  }

  const adooAccess = async (): Promise<string | undefined> => {
    const current = adooTokens.value
    if (!current) return
    if (current.expiresAt > Date.now()) return current.accessToken
    return renewAdoo()
  }

  /** GETs an adoo.live path with the stored token, renewing once on 401. */
  const adooGet = async (path: string): Promise<{ status: number; body: unknown } | undefined> => {
    const access = await adooAccess()
    if (!access) return
    const load = (token: string) => apiGet(undefined, path, token).catch(() => ({ status: 0, body: null }))
    const first = await load(access)
    if (first.status !== 401) return first
    const renewed = await renewAdoo()
    if (!renewed) return
    return load(renewed)
  }

  /** POSTs JSON to adoo.live, renewing once on 401. */
  const adooPost = async (path: string, body: unknown): Promise<{ status: number; body: unknown } | undefined> => {
    const access = await adooAccess()
    if (!access) return
    const send = (token: string) => apiPost(undefined, path, token, body).catch(() => ({ status: 0, body: null }))
    const first = await send(access)
    if (first.status !== 401) return first
    const renewed = await renewAdoo()
    if (!renewed) return
    return send(renewed)
  }

  const adooDownload = async (path: string): Promise<Response | undefined> => {
    const access = await adooAccess()
    if (!access) return
    const response = await apiDownload(undefined, path, access).catch(() => undefined)
    if (!response || response.status !== 401) return response
    const renewed = await renewAdoo()
    if (!renewed) return
    return apiDownload(undefined, path, renewed).catch(() => undefined)
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

  const gitHead = async (directory: string): Promise<string> => {
    if (!(await pathExists(join(directory, ".git")))) return ""
    const result = await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"], { env: commandEnv() }).catch(
      () => ({ stdout: "" }),
    )
    return result.stdout.trim()
  }

  /**
   * Package names installed in a virtualenv. Read through its own python so venvs created without
   * pip (uv venv) still list correctly.
   */
  const installedPackages = async (venv: string): Promise<string[]> => {
    const python = venv === "" ? "" : join(venv, "bin", "python")
    if (python === "" || !(await pathExists(python))) return []
    const result = await execFileAsync(
      python,
      [
        "-c",
        "import importlib.metadata as m, json; print(json.dumps(sorted({d.metadata['Name'] for d in m.distributions() if d.metadata['Name']})))",
      ],
      { env: commandEnv(), maxBuffer: 16 * 1024 * 1024 },
    ).catch(() => ({ stdout: "[]" }))
    try {
      const parsed: unknown = JSON.parse(result.stdout)
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
    } catch {
      return []
    }
  }

  /** The virtualenv a configuration uses: its version's own, else the workspace one. */
  const venvFor = async (workspace: OdooWorkspace, environment?: OdooEnvironment): Promise<string> => {
    const version = environment?.version
    const candidate = version ? join(workspace.root, "bin", version, ".venv") : ""
    if (candidate !== "" && (await pathExists(join(candidate, "bin", "python")))) return candidate
    return workspace.venvPath ?? ""
  }

  /**
   * Keeps `<workspace>/bin/odoo` and the state it sources in step with the active configuration, so a terminal in
   * the workspace runs `odoo` against the odoo.conf the panel shows.
   */
  const syncOdooCli = async (workspace: OdooWorkspace, environment?: OdooEnvironment) => {
    const active = environment ?? workspace.environments.find((item) => item.active) ?? workspace.environments[0]
    const venv = await venvFor(workspace, active)
    const version = active?.version ?? workspace.versions[0]?.name ?? ""
    const candidates = [
      version === "" ? "" : join(workspace.root, "bin", version, "odoo-bin"),
      join(workspace.root, "odoo", "odoo-bin"),
      join(workspace.root, "odoo-bin"),
    ].filter((path) => path !== "")
    let odooBin = ""
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        odooBin = candidate
        break
      }
    }
    const launcher = join(workspace.root, "bin", "odoo")
    const current = await readFile(launcher, "utf8").catch(() => "")
    // A launcher from another tool (e.g. a hand-written con18 script) is left alone.
    if (current === "" || current.includes(CLI_MARKER)) await writeIfChanged(launcher, cliLauncher(), 0o755)
    await writeIfChanged(
      join(workspace.root, ".odoo-run", "odoo-cli.env"),
      cliState({
        python: venv === "" ? join(workspace.root, ".venv", "bin", "python") : join(venv, "bin", "python"),
        odooBin,
        conf: active?.confPath ?? join(workspace.root, "config", "odoo.conf"),
      }),
      0o644,
    )
  }

  const repoRequirements = async (folder: string): Promise<string[]> => {
    const text = await readFile(join(folder, "requirements.txt"), "utf8").catch(() => "")
    return text === "" ? [] : parseRequirements(text)
  }

  /** A configuration that uses `bin/odoo-XX` must list that source's own addons; otherwise `web` is missing. */
  const applyVersionAddons = async (workspace: OdooWorkspace, label: string, version: string) => {
    const environment = workspace.environments.find((item) => item.label === label)
    if (!environment) return
    const paths: string[] = []
    for (const path of [
      join(workspace.root, "bin", version, "addons"),
      join(workspace.root, "bin", version, "odoo", "addons"),
    ]) {
      if (await pathExists(path)) paths.push(path)
    }
    if (paths.length === 0) return
    const text = await readFile(environment.confPath, "utf8").catch(() => "")
    const current = getAddonsPath(parseOdooConfig(text))
    const missing = paths.filter((path) => !current.includes(path))
    const next: string[] = [...missing]
    for (const path of current) if (await pathExists(path)) next.push(path)
    if (next.length === current.length && next.every((path) => current.includes(path))) return
    await writeFile(environment.confPath, setAddonsPathText(text, next))
  }

  const addonsItem = async (path: string, installed: string[]): Promise<AddonsState["active"][number]> => {
    const requirements = await repoRequirements(path)
    return {
      path,
      exists: await pathExists(path),
      requirements: requirements.length,
      missing: requirements.length === 0 ? [] : missingRequirements(requirements, installed),
    }
  }

  // Every path that was ever offered stays available, so a removed entry can be put back.
  const addonsState = async (directory: string, label: string): Promise<AddonsState> => {
    const workspace = await resolveWorkspace(directory)
    const environment = workspace?.environments.find((item) => item.label === label)
    if (!workspace || !environment) return { active: [], available: [] }
    const text = await readFile(environment.confPath, "utf8").catch(() => "")
    const active = getAddonsPath(parseOdooConfig(text))

    // Odoo raises on every static file while an addons_path entry is missing, so drop those.
    const existing: string[] = []
    for (const path of active) if (await pathExists(path)) existing.push(path)
    if (existing.length !== active.length) await writeFile(environment.confPath, setAddonsPathText(text, existing))

    const versionPaths: string[] = []
    if (environment.version) {
      for (const path of [
        join(workspace.root, "bin", environment.version, "addons"),
        join(workspace.root, "bin", environment.version, "odoo", "addons"),
      ]) {
        if (await pathExists(path)) versionPaths.push(path)
      }
    }
    const known = new Set([
      ...(addonsKnown.value[workspace.root] ?? []),
      ...existing,
      ...(await availableAddons(workspace.root)),
      ...versionPaths,
    ])
    addonsKnown.update((draft) => {
      draft[workspace.root] = [...known]
    })
    const installed = await installedPackages(await venvFor(workspace, environment))
    const available = [...known].filter((path) => !existing.includes(path)).sort()
    return {
      active: await Promise.all(existing.map((path) => addonsItem(path, installed))),
      available: await Promise.all(available.map((path) => addonsItem(path, installed))),
    }
  }

  const runAdooFlow = async (device: AdooDevice, run: AdooPending) => {
    let interval = device.interval
    const deadline = Date.now() + device.expiresIn * 1000
    while (!run.cancelled && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))
      if (run.cancelled) return
      const result = await pollDevice(undefined, device.deviceCode).catch(() => ({
        state: "error" as const,
        message: "Could not reach adoo.live",
      }))
      if (run.cancelled) return
      if (result.state === "ok") {
        adooTokens.set(result.tokens)
        const profile = await apiGet(undefined, "/api/v1/oauth/userinfo", result.tokens.accessToken).catch(
          () => undefined,
        )
        adooProfile.set(profile ? parseProfile(profile.body) : { sub: "", email: "", name: "", role: "" })
        adooPending = undefined
        return
      }
      if (result.state === "pending") continue
      if (result.state === "slow_down") {
        interval += 5
        continue
      }
      if (result.state === "denied") {
        run.state = "denied"
        return
      }
      if (result.state === "expired") {
        run.state = "expired"
        return
      }
      run.state = "error"
      run.message = result.message
      return
    }
    if (!run.cancelled) run.state = "expired"
  }

  /** Sync: pulls a repository already on disk and clones the missing ones. */
  const syncRepositories = async (repos: SyncRepo[], workspace: OdooWorkspace) => {
    for (const repo of repos) {
      if (repo.state === "error") continue
      const cloned = await pathExists(join(repo.folder, ".git"))
      if (cloned) {
        repo.state = "pull"
        let failure = await git(["-C", repo.folder, "pull", "--ff-only"])
        if (failure && isAuthFailure(failure)) {
          // The clone came from HTTPS but the repository needs credentials: switch its remote to SSH.
          const fallback = sshFallback(repo.url)
          if (fallback && !(await git(["-C", repo.folder, "remote", "set-url", "origin", fallback]))) {
            failure = await git(["-C", repo.folder, "pull", "--ff-only"])
          }
        }
        if (failure) {
          repo.state = "error"
          repo.message = failure
        } else {
          repo.state = "done"
          repo.message = ""
        }
        continue
      }
      repo.state = "clone"
      const target = cloneUrl(repo)
      const argsFor = (url: string) =>
        repo.branch ? ["clone", "--branch", repo.branch, url, repo.folder] : ["clone", url, repo.folder]
      let failure = await git(argsFor(target))
      if (failure) {
        const fallback = sshFallback(target)
        if (fallback && isAuthFailure(failure)) {
          await rm(repo.folder, { recursive: true, force: true }).catch(() => undefined)
          await mkdir(dirname(repo.folder), { recursive: true })
          failure = await git(argsFor(fallback))
        }
      }
      if (failure) {
        repo.state = "error"
        repo.message = failure
      } else {
        repo.state = "done"
        repo.message = ""
      }
    }

    // The cloned repositories are Odoo addons, so the selected configuration must find them.
    const folders = repos.filter((repo) => repo.state === "done" || repo.state === "skipped").map((repo) => repo.folder)
    const environment =
      workspace.environments.find((item) => item.label === (selected.value[workspace.root] ?? "")) ??
      workspace.environments.find((item) => item.active) ??
      workspace.environments[0]
    if (environment && folders.length > 0) {
      const text = await readFile(environment.confPath, "utf8").catch(() => "")
      const current = getAddonsPath(parseOdooConfig(text))
      const next = [...current]
      for (const folder of folders) if (!next.includes(folder)) next.push(folder)
      if (next.length !== current.length) await writeFile(environment.confPath, setAddonsPathText(text, next))
    }
  }

  const runSyncJob = async (job: SyncJob, workspace: OdooWorkspace) => {
    await syncRepositories(job.repos, workspace)
    job.running = false
  }

  const dataDirectory = async (workspace: OdooWorkspace): Promise<string> => {
    const label = selected.value[workspace.root]
    const environment =
      workspace.environments.find((item) => item.label === label) ??
      workspace.environments.find((item) => item.active) ??
      workspace.environments[0]
    if (!environment) return join(workspace.root, ".odoo-data")
    const config = parseOdooConfig(await readFile(environment.confPath, "utf8").catch(() => ""))
    return getString(config, "data_dir") ?? join(workspace.root, ".odoo-data")
  }

  /** Generates a backup in adoo.live, downloads it directly and restores it into a new local database. */
  const runRebuild = async (
    job: RebuildJob,
    workspace: OdooWorkspace,
    environment: string,
    stack: string,
    name: string,
    filestore: boolean,
    repos: boolean,
    neutralize: boolean,
  ) => {
    let archive = ""
    const step = (value: RebuildJob["step"], message = "") => {
      job.step = value
      job.message = message
    }
    try {
      const compose = workspace.dockerComposePath
      if (!compose) throw new Error("No docker-compose.yml found in this workspace")
      const service = parseDockerCompose(await readFile(compose, "utf8"))[0]
      if (!service) throw new Error("No Postgres service found in docker-compose.yml")
      const base = `/api/v1/environments/${encodeURIComponent(environment)}`
      let database = databaseName(name, new Date())
      job.database = database

      step("generate")
      const created = await adooPost(
        `${base}/database-pulls`,
        filestore ? { format: "zip", includes_filestore: true } : { format: "dump_custom" },
      )
      if (!created) throw new Error("adoo.live is not connected")
      if (created.status === 403) throw new Error("adoo.live refused the pull: the token needs the database scope")
      if (created.status >= 300) throw new Error(`adoo.live refused the database pull (${created.status})`)
      let pull = parsePull(created.body)

      step("wait")
      const deadline = Date.now() + 45 * 60 * 1000
      while (Date.now() < deadline) {
        if (!pull) break
        if (pullFailed(pull.status)) throw new Error(`The database pull failed (${pull.status})`)
        if (pullReady(pull)) break
        await sleep(3000)
        const status = await adooGet(`${base}/database-pulls/${encodeURIComponent(pull.id)}`)
        if (status?.status === 200) pull = parsePull(status.body) ?? pull
      }
      if (!pullReady(pull) || !pull) throw new Error("The database pull did not finish in time")

      step("download")
      const response = await adooDownload(pull.downloadPath)
      if (!response) throw new Error("adoo.live is not connected")
      if (!response.ok) throw new Error(`Download failed (${response.status})`)
      const runDir = join(workspace.root, "backups")
      await mkdir(runDir, { recursive: true })
      archive = join(runDir, `${database}.${filestore ? "zip" : "dump"}`)
      await writeBody(response, archive, (bytes, total) => {
        job.bytes = bytes
        job.totalBytes = total
      })

      step("create")
      await command("docker", ["compose", "-f", compose, "up", "-d", "--wait", service.name], workspace.root)
      const psql = ["compose", "-f", compose, "exec", "-T", service.name, "psql", "-U", "odoo", "-d", "postgres"]
      // Each rebuild gets a fresh name; if it ever collides, try another random one.
      let createdDb: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        createdDb = await command("docker", [...psql, "-c", `CREATE DATABASE "${database}"`], workspace.root)
        if (!createdDb || !createdDb.includes("already exists")) break
        database = databaseName(name, new Date())
        job.database = database
      }
      if (createdDb) throw new Error(createdDb)

      step("restore")
      const restore = ["compose", "-f", compose, "exec", "-T", service.name]
      let extracted = ""
      if (filestore) {
        extracted = await mkdtemp(join(tmpdir(), "odoo-rebuild-"))
        const failure = await command("unzip", ["-o", archive, "-d", extracted], workspace.root)
        if (failure) throw new Error(failure)
        const sql = await findFile(extracted, ".sql")
        if (sql) {
          const error = await commandInput(
            "docker",
            [...restore, "psql", "-U", "odoo", "-d", database],
            sql,
            workspace.root,
          )
          if (error) throw new Error(error)
        } else {
          const error = await commandInput(
            "docker",
            [...restore, "pg_restore", "-U", "odoo", "-d", database, "--no-owner", "--no-privileges"],
            archive,
            workspace.root,
          )
          if (error) throw new Error(error)
        }
      } else {
        const error = await commandInput(
          "docker",
          [...restore, "pg_restore", "-U", "odoo", "-d", database, "--no-owner", "--no-privileges"],
          archive,
          workspace.root,
        )
        if (error) throw new Error(error)
      }

      if (filestore) {
        step("filestore")
        const source = await findFilestore(extracted)
        if (source) {
          const data = await dataDirectory(workspace)
          await mkdir(join(data, "filestore"), { recursive: true })
          const failure = await command("cp", ["-R", source, join(data, "filestore", database)], workspace.root)
          if (failure) throw new Error(failure)
        }
      }

      if (neutralize) {
        step("neutralize")
        const label = selected.value[workspace.root]
        const local =
          workspace.environments.find((item) => item.label === label) ??
          workspace.environments.find((item) => item.active) ??
          workspace.environments[0]
        if (local) {
          const [python, bin] = environmentLaunchCommand(workspace, local)
          if (python && bin) {
            const failure = await command(
              python,
              [bin, "neutralize", "-c", local.confPath, "-d", database],
              workspace.root,
            )
            if (failure) throw new Error(`Neutralize failed: ${failure}`)
          }
        }
      }

      if (repos && stack !== "") {
        step("repos")
        const [stackResponse, environmentResponse] = await Promise.all([
          adooGet(`/api/v1/stacks/${encodeURIComponent(stack)}`),
          adooGet(`/api/v1/environments/${encodeURIComponent(environment)}/repositories`),
        ])
        const merged = mergeRepos(
          stackResponse?.status === 200 ? stackResponse.body : undefined,
          environmentResponse?.status === 200 ? environmentResponse.body : undefined,
        )
        if (merged.length > 0) {
          const syncRepos: SyncRepo[] = merged.map((repo) => {
            const folder = repoFolder(workspace.root, repo.url)
            return {
              path: folder?.relative ?? repo.name,
              folder: folder?.path ?? "",
              url: repo.url,
              branch: repo.branch,
              auth: repo.auth,
              state: folder ? ("pending" as const) : ("error" as const),
              message: folder ? "" : "Unsupported repository URL",
            }
          })
          await syncRepositories(syncRepos, workspace)
        }
      }

      if (extracted !== "") await rm(extracted, { recursive: true, force: true })
      step(
        "done",
        filestore
          ? `Database ${database} · backups/${database}.zip`
          : `Database ${database} · backups/${database}.dump (no filestore: images and icons will be missing)`,
      )
      job.running = false
    } catch (error) {
      job.running = false
      job.step = "error"
      job.message = String(error)
    }
  }

  ctx.onCleanup(() => {
    if (adooPending) adooPending.cancelled = true
    for (const pid of started) {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // already gone
        }
      }
    }
    started.clear()
  })

  ctx.provide(Odoo, {
    detect: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return null
      const summary = summarize(workspace)
      const chosen = selected.value[workspace.root]
      const activeLabel = chosen && summary.environments.includes(chosen) ? chosen : summary.activeEnvironment
      const environment = workspace.environments.find((item) => item.label === activeLabel)
      const activeHttpPort = environment
        ? (getString(parseOdooConfig(await readFile(environment.confPath, "utf8").catch(() => "")), "http_port") ?? "")
        : ""
      await syncOdooCli(workspace, environment).catch(() => undefined)
      return {
        ...summary,
        activeEnvironment: activeLabel,
        environmentVersion: environment?.version ?? "",
        activeHttpPort,
      }
    },

    setEnvironment: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return
      selected.update((draft) => {
        draft[workspace.root] = label
      })
      await syncOdooCli(
        workspace,
        workspace.environments.find((item) => item.label === label),
      )
    },

    odooCli: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { launcher: "", state: "", target: "", installed: false, current: "" }
      await syncOdooCli(workspace)
      const target = join(homedir(), ".local", "bin", "odoo")
      const body = await readFile(target, "utf8").catch(() => "")
      const link = await readlink(target).catch(() => "")
      return {
        launcher: join(workspace.root, "bin", "odoo"),
        state: join(workspace.root, ".odoo-run", "odoo-cli.env"),
        target,
        installed: body.includes(CLI_MARKER),
        current: link !== "" ? link : body.includes(CLI_MARKER) ? "opencode-odoo" : body === "" ? "" : "another",
      }
    },

    odooCliInstall: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      await syncOdooCli(workspace)
      const target = join(homedir(), ".local", "bin", "odoo")
      // Replace the link itself, never the script it points at.
      if ((await readlink(target).catch(() => "")) !== "") await rm(target, { force: true })
      await writeIfChanged(target, cliDispatcher(), 0o755)
      return `Installed ${target}`
    },

    /** Every Odoo process on the machine, read from `ps`; no workspace needed. */
    odooProcesses: async () => {
      const output = await execFileAsync("ps", ["-Ao", "pid=,command="], {
        env: commandEnv(),
        maxBuffer: 8 * 1024 * 1024,
      }).then(
        (result) => result.stdout,
        () => "",
      )
      const processes = await Promise.all(
        parseProcesses(output).map(async (item) => {
          const text = item.conf === "" ? "" : await readFile(item.conf, "utf8").catch(() => "")
          return {
            pid: item.pid,
            label: item.label,
            port: text === "" ? "" : (getString(parseOdooConfig(text), "http_port") ?? ""),
          }
        }),
      )
      return { processes }
    },

    odooKill: async ({ pid }) => {
      if (!Number.isInteger(pid) || pid <= 0) return "Invalid pid"
      const send = (target: number) => {
        try {
          process.kill(target, "SIGTERM")
          return true
        } catch {
          return false
        }
      }
      // Our Odoo starts detached: signalling the group also stops its workers.
      if (send(-pid) || send(pid)) return `Stopped pid ${pid}`
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      return alive ? `Could not stop pid ${pid}` : `Process ${pid} was already gone`
    },

    status: async ({ directory }): Promise<WorkspaceStatus> => {
      const workspace = await resolveWorkspace(directory)
      return workspace ? workspaceStatus(workspace) : { postgres: "none", environments: [] }
    },

    create: async ({ directory }) => {
      const created = await createWorkspace(directory)
      return created.length > 0 ? `Created ${created.length} file(s) in ${directory}` : "Workspace already initialized"
    },

    createConf: async ({ directory, name, version }) => {
      const workspace = await resolveWorkspace(directory)
      const created = await createConf(directory, name)
      if (!created) return "Configuration already exists"
      if (workspace && version) {
        const label = (created.split("/").pop() ?? created).replace(/\.conf$/, "")
        await writeVersion(workspace.root, label, version)
        await applyVersionAddons(workspace, label, version)
      }
      return `Created ${created}`
    },

    fixPorts: async ({ directory }) => {
      const { dbPort, httpPorts } = await reconfigureWorkspace(directory)
      return `Postgres port ${dbPort}; configs on HTTP ${httpPorts.join(", ") || "none"}`
    },

    deleteConf: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      const environment = workspace.environments.find((item) => item.label === label)
      if (!environment) return `Configuration "${label}" not found`
      const resolved = resolve(environment.confPath)
      if (!resolved.startsWith(join(workspace.root, "config") + sep) || !resolved.endsWith(".conf"))
        return "Only .conf files under config/ can be deleted"
      await rm(resolved, { force: true })
      await removeVersion(workspace.root, label)
      if (selected.value[workspace.root] === label)
        selected.update((draft) => {
          delete draft[workspace.root]
        })
      return `Deleted ${label}`
    },

    launch: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return null
      const environment = workspace.environments.find((item) => item.label === label)
      if (!environment) return null
      const [command, ...args] = environmentLaunchCommand(workspace, environment)
      if (!command) return null
      return { command, args, cwd: workspace.root }
    },

    log: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { text: "", path: "" }
      const environment =
        workspace.environments.find((item) => item.label === label) ??
        workspace.environments.find((item) => item.active) ??
        workspace.environments[0]
      const path = await logFileFor(workspace, environment, label)
      const text = await tailFile(path)
      return {
        text: text.trim().split("\n").slice(-300).join("\n") || "(no output yet)",
        path,
      }
    },

    confValues: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      const config = parseOdooConfig(environment ? await readFile(environment.confPath, "utf8").catch(() => "") : "")
      return {
        db_host: getString(config, "db_host") ?? "",
        db_port: getString(config, "db_port") ?? "",
        db_user: getString(config, "db_user") ?? "",
        db_password: getString(config, "db_password") ?? "",
        admin_passwd: getString(config, "admin_passwd") ?? "",
        http_port: getString(config, "http_port") ?? "",
        workers: getString(config, "workers") ?? "",
        max_cron_threads: getString(config, "max_cron_threads") ?? "",
        limit_time_cpu: getString(config, "limit_time_cpu") ?? "",
        limit_time_real: getString(config, "limit_time_real") ?? "",
        log_level: getString(config, "log_level") ?? "",
        dev: getString(config, "dev") ?? "",
        extra: [...config.options.entries()]
          .filter(([key]) => !isConfKey(key))
          .map(([key, value]) => ({ key, value: configValueText(value) })),
        sections: [...config.sections.entries()].map(([name, map]) => ({
          name,
          entries: [...map.entries()].map(([key, value]) => ({ key, value: configValueText(value) })),
        })),
      }
    },

    confSet: async ({ directory, label, key, value, section }) => {
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!environment) return "Configuration not found"
      const current = await readFile(environment.confPath, "utf8").catch(() => "")
      const next = setEntryText(
        current,
        section && section !== "" ? section : "options",
        key,
        value === "" ? undefined : value,
      )
      if (next === current) return value === "" ? `${key} was not set` : `Set ${key}`
      await writeFile(environment.confPath, next)
      return value === "" ? `Removed ${key}` : `Set ${key}`
    },

    confExtra: async ({ directory, label, text }) => {
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!environment) return "Configuration not found"
      const current = await readFile(environment.confPath, "utf8").catch(() => "")
      const merged = applyConfigLines(current, text)
      if (merged.keys.length === 0) return "No options to add"
      await writeFile(environment.confPath, merged.text)
      return `Added ${merged.keys.join(", ")}`
    },

    install: async ({ directory, version, conf, python }) => {
      if (installJob?.running) return { started: false, message: "An installation is already running" }
      const job: InstallJob = { running: true, version, conf, step: "", message: "", startedAt: Date.now() }
      installJob = job
      void installOdoo(
        directory,
        version,
        (step) => {
          job.step = step
        },
        python ?? "",
      ).then(
        async (message) => {
          job.running = false
          job.step = "done"
          job.message = message
          // A configuration created together with the install adopts the new version.
          if (job.conf !== "") {
            const workspace = await resolveWorkspace(directory)
            if (workspace) {
              const name = `odoo-${version.split(".")[0] || version}`
              await writeVersion(workspace.root, confLabel(job.conf), name)
              await applyVersionAddons(workspace, confLabel(job.conf), name)
            }
          } else {
            const workspace = await resolveWorkspace(directory)
            if (workspace) {
              const name = `odoo-${version.split(".")[0] || version}`
              const label =
                selected.value[workspace.root] ??
                workspace.environments.find((item) => item.active)?.label ??
                workspace.environments[0]?.label
              if (label) {
                const map = await readVersionMap(workspace.root)
                if (!map[label] || map[label] === name) await applyVersionAddons(workspace, label, name)
              }
            }
          }
        },
        (error: unknown) => {
          job.running = false
          job.step = "error"
          job.message = String(error)
        },
      )
      return { started: true, message: "" }
    },

    installStatus: async () => {
      const job = installJob
      return {
        running: job?.running ?? false,
        version: job?.version ?? "",
        step: job?.step ?? ("" as const),
        message: job?.message ?? "",
        startedAt: job?.startedAt ?? 0,
      }
    },

    pythonInstall: async ({ directory, version, packages }) => {
      if (pythonJob?.running) return { started: false, message: "A pip install is already running" }
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { started: false, message: "No Odoo workspace found for this directory" }
      if (!workspace.versions.some((item) => item.name === version)) {
        return { started: false, message: `Version "${version}" not found` }
      }
      const list = packages.split(/\s+/).filter((item) => item !== "")
      if (list.length === 0) return { started: false, message: "Type a package name" }
      const venv = join(workspace.root, "bin", version, ".venv")
      const runner = await pipInstall(venv, list)
      if (!runner) return { started: false, message: `No virtualenv at bin/${version}/.venv` }

      const job: PythonJob = {
        running: true,
        version,
        packages: list.join(" "),
        message: "",
        startedAt: Date.now(),
      }
      pythonJob = job
      void (async () => {
        const local = join(workspace.root, "requirements-local.txt")
        const current = await readFile(local, "utf8").catch(() => "")
        const lines = current.split("\n").map((line) => line.trim())
        const missing = list.filter((item) => !lines.includes(item))
        if (missing.length > 0) {
          const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : ""
          await writeFile(local, `${current}${prefix}${missing.join("\n")}\n`)
        }
        const failure = await command(runner.file, runner.args, workspace.root)
        job.running = false
        job.message = failure ?? `Installed ${list.join(", ")}`
      })()
      return { started: true, message: "" }
    },

    pythonInstallStatus: async () => {
      const job = pythonJob
      return {
        running: job?.running ?? false,
        version: job?.version ?? "",
        packages: job?.packages ?? "",
        message: job?.message ?? "",
        startedAt: job?.startedAt ?? 0,
      }
    },

    venvPython: async ({ directory, version }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { python: "" }
      return { python: await venvPythonVersion(join(workspace.root, "bin", version, ".venv")) }
    },

    /** Recreates a version's virtualenv with another Python and installs its requirements again. */
    venvRecreate: async ({ directory, version, python }) => {
      if (installJob?.running) return { started: false, message: "An installation is already running" }
      const workspace = await resolveWorkspace(directory)
      const info = workspace?.versions.find((item) => item.name === version)
      if (!workspace || !info) return { started: false, message: `Version "${version}" not found` }
      const chosen = python.trim()
      if (chosen === "") return { started: false, message: "Choose a Python version" }
      const current = await venvPythonVersion(join(workspace.root, "bin", version, ".venv"))
      if (current === chosen) return { started: false, message: `Already using Python ${current}` }
      const job: InstallJob = {
        running: true,
        version: info.series,
        conf: "",
        step: "",
        message: "",
        startedAt: Date.now(),
      }
      installJob = job
      void installOdoo(
        directory,
        info.series,
        (step) => {
          job.step = step
        },
        chosen,
      ).then(
        (message) => {
          job.running = false
          job.step = "done"
          job.message = message
        },
        (error: unknown) => {
          job.running = false
          job.step = "error"
          job.message = String(error)
        },
      )
      return { started: true, message: "" }
    },

    databases: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { databases: [], backups: [] }
      const environment =
        workspace.environments.find((item) => item.active) ?? workspace.environments[0]
      const text = environment ? await readFile(environment.confPath, "utf8").catch(() => "") : ""
      const dataDir = getString(parseOdooConfig(text), "data_dir") ?? join(workspace.root, ".odoo-data")
      const listed = await runSql(
        workspace,
        "postgres",
        "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database WHERE datistemplate = false AND datallowconn = true AND datname <> 'postgres' ORDER BY datname",
      )
      const databases = await Promise.all(
        parseDatabases(listed.stdout).map(async (item) => ({
          ...item,
          filestore: await pathExists(join(dataDir, "filestore", item.name)),
        })),
      )
      const backupDir = join(workspace.root, "backups")
      const backups = await Promise.all(
        (await readdir(backupDir, { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isFile() && /\.(dump|zip|sql)$/.test(entry.name))
          .map(async (entry) => {
            const info = await stat(join(backupDir, entry.name)).catch(() => undefined)
            const size = info ? `${(info.size / (1024 * 1024)).toFixed(1)} MB` : ""
            return { name: entry.name, size }
          }),
      )
      return { databases, backups: backups.sort((a, b) => a.name.localeCompare(b.name)) }
    },

    databaseAction: async ({ directory, label, action, name, from, demo, file }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      const login = await postgresLogin(workspace)
      if (!login) return "No Postgres service found in docker-compose.yml"
      const environment =
        workspace.environments.find((item) => item.label === label) ??
        workspace.environments.find((item) => item.active) ??
        workspace.environments[0]
      if (!environment) return "Configuration not found"
      const target = safeDatabaseName(name)
      if (target === "") return "Write a database name"
      const terminate = (database: string) =>
        runSql(
          workspace,
          "postgres",
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database.replace(/'/g, "''")}' AND pid <> pg_backend_pid()`,
        )

      if (action === "create") {
        const created = await runSql(workspace, "postgres", `CREATE DATABASE ${quoteIdentifier(target)}`)
        if (!created.ok) return created.error || "Could not create the database"
        const launch = environmentLaunchCommand(workspace, environment)
        const args = [
          "-d",
          target,
          "-i",
          "base",
          "--stop-after-init",
          "--no-http",
          ...(demo ? [] : ["--without-demo=all"]),
        ]
        const failure = await command(launch[0] ?? "python3", [...launch.slice(1), ...args], workspace.root)
        return failure ?? `Created ${target}${demo ? " with demo data" : ""}`
      }

      if (action === "duplicate") {
        const source = safeDatabaseName(from)
        if (source === "") return "Choose the database to copy"
        await terminate(source)
        const copied = await runSql(
          workspace,
          "postgres",
          `CREATE DATABASE ${quoteIdentifier(target)} TEMPLATE ${quoteIdentifier(source)}`,
        )
        if (!copied.ok) return copied.error || "Could not duplicate the database"
        const text = await readFile(environment.confPath, "utf8").catch(() => "")
        const dataDir = getString(parseOdooConfig(text), "data_dir") ?? join(workspace.root, ".odoo-data")
        const origin = join(dataDir, "filestore", source)
        if (await pathExists(origin)) await cp(origin, join(dataDir, "filestore", target), { recursive: true, force: true })
        return `Duplicated ${source} into ${target}`
      }

      if (action === "drop") {
        if (["postgres", "template0", "template1"].includes(target)) return "That database cannot be dropped"
        await terminate(target)
        const dropped = await runSql(workspace, "postgres", `DROP DATABASE ${quoteIdentifier(target)}`)
        return dropped.ok ? `Dropped ${target}` : dropped.error || "Could not drop the database"
      }

      if (action === "backup") {
        const dir = join(workspace.root, "backups")
        await mkdir(dir, { recursive: true })
        const path = join(dir, `${target}.dump`)
        const failure = await commandToFile(
          ["docker", "compose", "-f", login.compose, "exec", "-T", login.service, "pg_dump", "-U", login.user, "-Fc", "-d", target],
          path,
        )
        return failure ?? `Saved ${path}`
      }

      const source = join(workspace.root, "backups", file)
      if (!(await pathExists(source))) return "Choose a backup file"
      const created = await runSql(workspace, "postgres", `CREATE DATABASE ${quoteIdentifier(target)}`)
      if (!created.ok) return created.error || "Could not create the database"
      const failure = await commandFromFile(
        file.endsWith(".sql")
          ? [
              "docker",
              "compose",
              "-f",
              login.compose,
              "exec",
              "-T",
              login.service,
              "psql",
              "-U",
              login.user,
              "-d",
              target,
            ]
          : [
              "docker",
              "compose",
              "-f",
              login.compose,
              "exec",
              "-T",
              login.service,
              "pg_restore",
              "-U",
              login.user,
              "-d",
              target,
              "--no-owner",
              "--no-privileges",
            ],
        source,
      )
      return failure ?? `Restored ${file} into ${target}`
    },

    modules: async ({ directory, database }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace || database === "") return { modules: [] }
      const listed = await runSql(
        workspace,
        database,
        "SELECT name, state, latest_version FROM ir_module_module ORDER BY name",
      )
      return { modules: parseModules(listed.stdout) }
    },

    moduleAction: async ({ directory, label, database, module: name, action }) => {
      if (moduleJob?.running) return { started: false, message: "A module operation is already running" }
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!workspace || !environment) return { started: false, message: "Configuration not found" }
      if (database === "") return { started: false, message: "Choose a database" }
      const launch = environmentLaunchCommand(workspace, environment)
      const args = [
        "-d",
        database,
        action === "install" ? "-i" : "-u",
        name,
        "--stop-after-init",
        "--no-http",
      ]
      if (action === "test") args.push("--test-enable", "--test-tags", `/${name}`)
      const log = join(workspace.root, ".odoo-run", `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}-modules.log`)
      await mkdir(dirname(log), { recursive: true })
      const job: ModuleJob = {
        running: true,
        action,
        module: name,
        database,
        message: `${action} ${name}…`,
        startedAt: Date.now(),
      }
      moduleJob = job
      const output = createWriteStream(log, { flags: "a" })
      const child = spawn(launch[0] ?? "python3", [...launch.slice(1), ...args], {
        cwd: workspace.root,
        env: commandEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      })
      let tail = ""
      const append = (chunk: Buffer) => {
        const text = chunk.toString()
        tail = (tail + text).slice(-2000)
        output.write(text)
      }
      child.stdout.on("data", append)
      child.stderr.on("data", append)
      child.on("error", (error) => {
        output.end()
        job.running = false
        job.message = String(error)
      })
      child.on("close", (code) => {
        output.end()
        job.running = false
        job.message =
          code === 0
            ? `${action} ${name} finished`
            : tail.trim().split("\n").slice(-3).join(" ").trim() || `exit ${code}`
      })
      return { started: true, message: "" }
    },

    moduleStatus: async () => {
      const job = moduleJob
      return {
        running: job?.running ?? false,
        action: job?.action ?? "",
        module: job?.module ?? "",
        database: job?.database ?? "",
        message: job?.message ?? "",
      }
    },

    reposUpdate: async ({ directory, hard, paths }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { results: [], updated: 0, failed: 0 }
      const results = await updateRepositories(workspace.root, { hard, paths })
      return {
        results,
        updated: results.filter((result) => result.state === "updated").length,
        failed: results.filter((result) => result.state === "error").length,
      }
    },

    reposStatus: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { repos: [] }
      return { repos: await inspectRepositories(workspace.root) }
    },

    reposUpdateLog: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { text: "" }
      const text = await tailFile(reposUpdateLogPath(workspace.root))
      return { text: text.trim().split("\n").slice(-300).join("\n") }
    },

    skillPack: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { installed: false, path: "", branch: "", commit: "", skills: 0 }
      return skillPackStatus(workspace.root)
    },

    skillPackUpdate: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      return installSkillPack(workspace.root)
    },

    cloneRepo: async ({ directory, url, branch, ssh, addons }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { ok: false, message: "No Odoo workspace found for this directory", relative: "" }
      const result = await cloneRepository(workspace.root, { url, branch, ssh })
      if (!result.ok || !addons) return { ok: result.ok, message: result.message, relative: result.relative }
      const environment =
        workspace.environments.find((item) => item.label === selected.value[workspace.root]) ??
        workspace.environments.find((item) => item.active) ??
        workspace.environments[0]
      if (environment) await addFolderToAddons(environment.confPath, result.path).catch(() => undefined)
      return { ok: true, message: result.message, relative: result.relative }
    },

    shell: async ({ directory, label, database, code }) => {
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!workspace || !environment) return "Configuration not found"
      if (database === "") return "Choose a database"
      if (code.trim() === "") return "Write some Python code"
      const launch = environmentLaunchCommand(workspace, environment)
      const [file, bin, ...rest] = launch
      return new Promise((resolve) => {
        const child = spawn(
          file ?? "python3",
          [bin ?? "", "shell", ...rest, "-d", database, "--shell-interface=python"],
          { cwd: workspace.root, env: commandEnv(), stdio: ["pipe", "pipe", "pipe"] },
        )
        let stdout = ""
        let stderr = ""
        const timer = setTimeout(() => child.kill("SIGKILL"), 120000)
        child.stdout.on("data", (chunk: Buffer) => {
          stdout = (stdout + chunk.toString()).slice(-20000)
        })
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-20000)
        })
        child.on("error", (error) => {
          clearTimeout(timer)
          resolve(String(error))
        })
        child.on("close", () => {
          clearTimeout(timer)
          const noise = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d+ \d+ (INFO|DEBUG) /
          const errors = stderr
            .split("\n")
            .filter((line) => !noise.test(line))
            .join("\n")
            .trim()
          resolve([stdout.trim(), errors].filter((part) => part !== "").join("\n") || "(no output)")
        })
        child.stdin.write(`${code}\n`)
        child.stdin.end()
      })
    },

    debugStart: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!workspace || !environment) return { started: false, message: "Configuration not found" }
      const venv = await venvFor(workspace, environment)
      const runner = venv === "" ? undefined : await pipInstall(venv, ["debugpy"])
      if (!runner) return { started: false, message: "No virtualenv found for this configuration" }
      const installed = await command(runner.file, runner.args, workspace.root)
      if (installed) return { started: false, message: installed }
      const launch = environmentLaunchCommand(workspace, environment)
      const pidPath = pidFile(workspace.root, `${label}-debug`)
      const log = join(workspace.root, ".odoo-run", `${label.replace(/[^a-zA-Z0-9_-]/g, "_")}-debug.log`)
      await stopProcess(pidPath)
      const pid = await startProcess(
        [launch[0] ?? "python3", "-m", "debugpy", "--listen", "127.0.0.1:5678", ...launch.slice(1)],
        { pidFile: pidPath, cwd: workspace.root, logFile: log, env: commandEnv() },
      )
      await writeLaunchConfig(workspace.root).catch(() => undefined)
      return {
        started: true,
        message: `Debug listening on 127.0.0.1:5678 (pid ${pid}). Attach with "Odoo: attach" in VS Code.`,
      }
    },

    debugStop: async ({ directory, label }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      const stopped = await stopProcess(pidFile(workspace.root, `${label}-debug`))
      return stopped ? "Debug session stopped" : "No debug session running"
    },

    addons: async ({ directory, label }) => addonsState(directory, label),

    addonsToggle: async ({ directory, label, path, enabled }) => {
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!workspace || !environment) return { active: [], available: [] }
      const text = await readFile(environment.confPath, "utf8").catch(() => "")
      const current = getAddonsPath(parseOdooConfig(text))
      const requested = enabled
        ? current.includes(path)
          ? current
          : [...current, path]
        : current.filter((item) => item !== path)
      // A missing entry makes Odoo fail every static request, so only existing folders are written.
      const next: string[] = []
      for (const item of requested) if (await pathExists(item)) next.push(item)
      await writeFile(environment.confPath, setAddonsPathText(text, next))
      return addonsState(directory, label)
    },

    addonsDeps: async ({ directory, label, path }) => {
      if (pythonJob?.running) return { started: false, message: "A pip install is already running" }
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!workspace || !environment) return { started: false, message: "Configuration not found" }
      const file = join(path, "requirements.txt")
      if (!(await pathExists(file))) return { started: false, message: "No requirements.txt in that folder" }
      const venv = await venvFor(workspace, environment)
      const runner = venv === "" ? undefined : await pipInstall(venv, ["-r", file])
      if (!runner) return { started: false, message: "No virtualenv found for this configuration" }
      const name = path.startsWith(`${workspace.root}/`) ? path.slice(workspace.root.length + 1) : path

      const job: PythonJob = {
        running: true,
        version: environment.version ?? "venv",
        packages: name,
        message: "",
        startedAt: Date.now(),
      }
      pythonJob = job
      void (async () => {
        const failure = await command(runner.file, runner.args, workspace.root)
        job.running = false
        job.message = failure ?? `Installed ${name}`
      })()
      return { started: true, message: "" }
    },

    /** Installs the requirements of every active addons path that still has missing packages. */
    addonsDepsAll: async ({ directory, label }) => {
      if (pythonJob?.running) return { started: false, message: "A pip install is already running" }
      const workspace = await resolveWorkspace(directory)
      const environment = workspace?.environments.find((item) => item.label === label)
      if (!workspace || !environment) return { started: false, message: "Configuration not found" }
      const venv = await venvFor(workspace, environment)
      const runner = venv === "" ? undefined : await pipInstall(venv, [])
      if (!runner) return { started: false, message: "No virtualenv found for this configuration" }
      const installed = await installedPackages(venv)
      const text = await readFile(environment.confPath, "utf8").catch(() => "")
      const targets: Array<{ path: string; name: string }> = []
      for (const path of getAddonsPath(parseOdooConfig(text))) {
        const file = join(path, "requirements.txt")
        if (!(await pathExists(file))) continue
        const requirements = await repoRequirements(path)
        if (requirements.length === 0) continue
        if (missingRequirements(requirements, installed).length === 0) continue
        const name = path.startsWith(`${workspace.root}/`) ? path.slice(workspace.root.length + 1) : path
        targets.push({ path, name })
      }
      if (targets.length === 0) return { started: false, message: "Every repository has its requirements installed" }

      const job: PythonJob = {
        running: true,
        version: environment.version ?? "venv",
        packages: targets.map((target) => target.name).join(", "),
        message: "",
        startedAt: Date.now(),
      }
      pythonJob = job
      void (async () => {
        const failures: string[] = []
        for (const [index, target] of targets.entries()) {
          job.message = `Installing ${target.name} (${index + 1}/${targets.length})…`
          const failure = await command(
            runner.file,
            [...runner.args, "-r", join(target.path, "requirements.txt")],
            workspace.root,
          )
          if (failure) failures.push(`${target.name}: ${failure}`)
        }
        job.running = false
        job.message =
          failures.length === 0
            ? `Installed requirements of ${targets.length} ${targets.length === 1 ? "repository" : "repositories"}`
            : `${failures.length} of ${targets.length} failed: ${failures.join(" · ")}`
      })()
      return { started: true, message: "" }
    },

    postgres: async ({ directory, action }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      if (!workspace.dockerComposePath) return "No docker-compose.yml found in this workspace"
      const service = parseDockerCompose(await readFile(workspace.dockerComposePath, "utf8"))[0]
      if (!service) return "No Postgres service found in docker-compose.yml"
      const commands = postgresCommands(workspace.dockerComposePath, service.name)
      if (action === "status") {
        const { stdout } = await docker(["compose", "-f", workspace.dockerComposePath, "ps", service.name])
        return stdout.trim() || `${service.name}: not running`
      }
      const command = action === "up" ? commands.up : action === "down" ? commands.down : commands.restart
      const { stdout, stderr } = await docker(command.slice(1))
      return (stdout + stderr).trim() || `Postgres ${action} ok`
    },

    odoo: async ({ directory, label, action }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return "No Odoo workspace found for this directory"
      const environment = workspace.environments.find((item) => item.label === label)
      if (!environment) return `Environment "${label}" not found in ${workspace.root}`
      const command = environmentLaunchCommand(workspace, environment)
      const pidPath = pidFile(workspace.root, label)
      if (action === "stop") {
        const stopped = await stopProcess(pidPath)
        return stopped ? `Stopped ${label}` : `No running process found for ${label}`
      }
      if (workspace.dockerComposePath) {
        const service = parseDockerCompose(await readFile(workspace.dockerComposePath, "utf8"))[0]
        if (service)
          await docker(["compose", "-f", workspace.dockerComposePath, "up", "-d", "--wait", service.name]).catch(
            () => undefined,
          )
      }
      const logFile = `${workspace.root}/.odoo-run/${label.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`
      const pid =
        action === "start"
          ? await startProcess(command, { pidFile: pidPath, cwd: workspace.root, logFile, env: commandEnv() })
          : await restartProcess(command, { pidFile: pidPath, cwd: workspace.root, logFile, env: commandEnv() })
      started.add(pid)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      if (!(await isProcessRunning(pidPath))) {
        const log = await readFile(logFile, "utf8").catch(() => "")
        const tail = log.trim().split("\n").slice(-12).join("\n")
        return `Odoo exited right after starting${tail ? `:\n${tail}` : "."}`
      }
      return `${action === "start" ? "Started" : "Restarted"} ${label} (pid ${pid})`
    },

    adooStatus: async () => adooStatus(),

    adooStart: async () => {
      if (adooPending) adooPending.cancelled = true
      adooPending = undefined
      const device = await requestDevice()
      const run: AdooPending = {
        cancelled: false,
        userCode: device.userCode,
        verificationUri: device.verificationUriComplete,
        state: "pending",
        message: "",
      }
      adooPending = run
      void runAdooFlow(device, run)
      return {
        userCode: device.userCode,
        verificationUri: device.verificationUriComplete,
        expiresIn: device.expiresIn,
        interval: device.interval,
      }
    },

    adooLogout: async () => {
      if (adooPending) adooPending.cancelled = true
      adooPending = undefined
      const current = adooTokens.value
      if (current) await revokeToken(undefined, current.refreshToken).catch(() => undefined)
      adooTokens.set(null)
      adooProfile.set(null)
      return "adoo.live disconnected"
    },

    adooData: async () => {
      const response = await adooGet("/api/v1/environments")
      if (!response) return adooEmpty()
      const profile = adooProfile.value
      return {
        connected: true,
        forbidden: response.status === 403,
        email: profile?.email ?? "",
        name: profile?.name ?? "",
        role: profile?.role ?? "",
        environments: normalizeItems(response.body),
      }
    },

    /** The environment detail carries the database name; the list does not. */
    adooDatabase: async ({ environment }) => {
      const response = await adooGet(`/api/v1/environments/${encodeURIComponent(environment)}`)
      if (!response || response.status !== 200) return { database: "" }
      return { database: environmentDatabase(response.body) }
    },

    adooSync: async ({ directory, stack, environment }) => {
      if (syncJob?.running) return { started: false, message: "A sync is already running" }
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { started: false, message: "No Odoo workspace found for this directory" }
      const [stackResponse, environmentResponse] = await Promise.all([
        stack === "" ? Promise.resolve(undefined) : adooGet(`/api/v1/stacks/${encodeURIComponent(stack)}`),
        adooGet(`/api/v1/environments/${encodeURIComponent(environment)}/repositories`),
      ])
      if (!stackResponse && !environmentResponse) return { started: false, message: "adoo.live is not connected" }
      // The environment repositories endpoint includes the project's extra addons, which the stack does not have.
      const repos = mergeRepos(
        stackResponse?.status === 200 ? stackResponse.body : undefined,
        environmentResponse?.status === 200 ? environmentResponse.body : undefined,
      )
      if (repos.length === 0) {
        return {
          started: false,
          message:
            stackResponse && stackResponse.status !== 200
              ? `adoo.live refused the stack (${stackResponse.status})`
              : "This environment has no repositories",
        }
      }

      const job: SyncJob = {
        running: true,
        environment,
        repos: repos.map((repo) => {
          const folder = repoFolder(workspace.root, repo.url)
          return {
            path: folder?.relative ?? repo.name,
            folder: folder?.path ?? "",
            url: repo.url,
            branch: repo.branch,
            auth: repo.auth,
            state: folder ? "pending" : "error",
            message: folder ? "" : "Unsupported repository URL",
          }
        }),
      }
      syncJob = job
      void runSyncJob(job, workspace)
      return { started: true, message: "" }
    },

    adooSyncStatus: async () => {
      const job = syncJob
      if (!job) return { running: false, environment: "", done: 0, total: 0, repos: [] }
      const done = job.repos.filter(
        (repo) => repo.state === "done" || repo.state === "skipped" || repo.state === "error",
      ).length
      return {
        running: job.running,
        environment: job.environment,
        done,
        total: job.repos.length,
        repos: job.repos.map((repo) => ({ path: repo.path, state: repo.state, message: repo.message })),
      }
    },

    adooRepos: async ({ directory, environment }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { message: "No Odoo workspace found for this directory", venv: "", repos: [] }
      const response = await adooGet(`/api/v1/environments/${encodeURIComponent(environment)}/repositories`)
      if (!response) return { message: "adoo.live is not connected", venv: "", repos: [] }
      if (response.status !== 200) {
        return { message: `adoo.live refused the repositories (${response.status})`, venv: "", repos: [] }
      }

      // Dependencies are checked against the virtualenv of the selected configuration's version.
      const label = selected.value[workspace.root]
      const local =
        workspace.environments.find((item) => item.label === label) ??
        workspace.environments.find((item) => item.active) ??
        workspace.environments[0]
      const venv = await venvFor(workspace, local)
      const installed = venv === "" ? [] : await installedPackages(venv)
      const venvLabel =
        venv === "" ? "" : venv.startsWith(`${workspace.root}/`) ? venv.slice(workspace.root.length + 1) : venv

      const repos = await Promise.all(
        parseEnvironmentRepos(response.body).map(async (repo) => {
          const folder = repoFolder(workspace.root, repo.url)
          if (!folder)
            return {
              path: repo.name,
              branch: repo.branch,
              commit: repo.commit,
              local: "",
              localBranch: "",
              changed: 0,
              state: "error" as const,
              message: "Unsupported repository URL",
              requirements: 0,
              missing: [],
            }
          const head = await gitHead(folder.path)
          const state =
            head === ""
              ? ("missing" as const)
              : repo.commit === ""
                ? ("unknown" as const)
                : sameCommit(repo.commit, head)
                  ? ("same" as const)
                  : ("different" as const)
          const localBranch = head === "" ? "" : await gitText(["rev-parse", "--abbrev-ref", "HEAD"], folder.path)
          const status = head === "" ? "" : await gitText(["status", "--porcelain", "--untracked-files=all"], folder.path)
          const changed = status === "" ? 0 : status.split("\n").filter((line) => line.trim() !== "").length
          const requirements = await repoRequirements(folder.path)
          return {
            path: folder.relative,
            branch: repo.branch,
            commit: repo.commit,
            local: head,
            localBranch,
            changed,
            state,
            message: "",
            requirements: requirements.length,
            missing: requirements.length === 0 ? [] : missingRequirements(requirements, installed),
          }
        }),
      )
      return { message: "", venv: venvLabel, repos }
    },

    repoChanges: async ({ directory, repository }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { branch: "", files: [], diff: "" }
      const path = resolve(workspace.root, repository)
      if (!path.startsWith(`${workspace.root}${sep}`) || !(await pathExists(join(path, ".git")))) {
        return { branch: "", files: [], diff: "" }
      }
      const branch = await gitText(["rev-parse", "--abbrev-ref", "HEAD"], path)
      const status = await gitText(["status", "--porcelain", "--untracked-files=all"], path)
      const files = status
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => ({ code: line.slice(0, 2).trim(), path: line.slice(3).trim() }))
      // `HEAD` includes staged changes; a repository without commits only has the working tree diff.
      const stat = (await gitText(["diff", "HEAD", "--stat"], path)) || (await gitText(["diff", "--stat"], path))
      const diff = (await gitText(["diff", "HEAD"], path)) || (await gitText(["diff"], path))
      return { branch, files, diff: [stat, diff].filter(Boolean).join("\n\n").slice(0, 20000) }
    },

    gitRepos: async ({ directory }) => {
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { repos: [] }
      const candidates: Array<{ path: string; name: string }> = [
        { path: workspace.root, name: "" },
        { path: join(workspace.root, "custom"), name: "custom" },
      ]
      const base = join(workspace.root, "repo")
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
          if (!(await pathExists(join(candidate.path, ".git")))) return undefined
          const status = await gitText(["status", "--porcelain", "--untracked-files=all"], candidate.path)
          return { path: candidate.name, changed: parseGitStatus(status).length }
        }),
      )
      return { repos: repos.filter((repo) => repo !== undefined) }
    },

    gitState: async ({ directory, repository }) => {
      const path = await gitRepository(directory, repository)
      if (!path) {
        return {
          root: "",
          branch: "",
          head: "",
          ahead: 0,
          behind: 0,
          upstream: "",
          operation: "",
          branches: [],
          files: [],
          stash: [],
          stats: [],
        }
      }
      const [branch, head, counts, upstream, branches, status, stash, staged, worktree, gitDir] = await Promise.all([
        gitText(["rev-parse", "--abbrev-ref", "HEAD"], path),
        gitText(["log", "-1", "--format=%h %s"], path),
        gitText(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], path),
        gitText(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], path),
        gitText(["for-each-ref", "--format=%(refname:short)", "refs/heads"], path),
        gitText(["status", "--porcelain", "--untracked-files=all"], path),
        gitText(["stash", "list", "--format=%gd%x09%s"], path),
        gitText(["diff", "--cached", "--numstat"], path),
        gitText(["diff", "--numstat"], path),
        gitText(["rev-parse", "--absolute-git-dir"], path),
      ])
      const markers: Array<[string, string]> = [
        ["MERGE_HEAD", "merge"],
        ["rebase-merge", "rebase"],
        ["rebase-apply", "rebase"],
        ["CHERRY_PICK_HEAD", "cherry-pick"],
        ["REVERT_HEAD", "revert"],
        ["BISECT_LOG", "bisect"],
      ]
      let operation = ""
      if (gitDir !== "") {
        for (const [marker, name] of markers) {
          if (await pathExists(join(gitDir, marker))) {
            operation = name
            break
          }
        }
      }
      return {
        root: path,
        branch,
        head,
        ...parseAheadBehind(counts),
        upstream,
        operation,
        branches: parseGitBranches(branches),
        files: parseGitStatus(status),
        stash: parseGitStash(stash),
        stats: [
          ...parseGitNumstat(worktree).map((stat) => ({ ...stat, staged: false })),
          ...parseGitNumstat(staged).map((stat) => ({ ...stat, staged: true })),
        ],
      }
    },

    gitDiff: async ({ directory, repository, path, staged }) => {
      const repositoryPath = await gitRepository(directory, repository)
      if (!repositoryPath) return { diff: "" }
      const diff = await gitText(staged ? ["diff", "--staged", "--", path] : ["diff", "--", path], repositoryPath)
      if (diff !== "") return { diff: diff.slice(0, 20000) }
      if (staged) return { diff: "" }
      // An untracked file has no diff; show it as added lines.
      const text = await readFile(join(repositoryPath, path), "utf8").catch(() => "")
      if (text === "" || text.includes("\u0000")) return { diff: "" }
      return {
        diff: text
          .split("\n")
          .slice(0, 400)
          .map((line) => `+${line}`)
          .join("\n")
          .slice(0, 20000),
      }
    },

    gitStagedDiff: async ({ directory, repository }) => {
      const repositoryPath = await gitRepository(directory, repository)
      if (!repositoryPath) return { diff: "" }
      const diff = await gitText(["diff", "--staged"], repositoryPath)
      return { diff: diff.slice(0, 16000) }
    },

    gitUndo: async ({ directory, repository, count }) => {
      const repositoryPath = await gitRepository(directory, repository)
      if (!repositoryPath) return "Not a git repository"
      const steps = Math.max(1, Math.floor(count))
      const target = await gitText(["rev-parse", "--verify", `HEAD~${steps}`], repositoryPath)
      if (target === "") return `There are fewer than ${steps} commits to undo`
      // Soft reset: the commits go away and their changes stay staged.
      return (
        (await git(["reset", "--soft", `HEAD~${steps}`], repositoryPath)) ??
        `Undid ${steps} commit${steps === 1 ? "" : "s"}; their changes are staged`
      )
    },

    gitLog: async ({ directory, repository, limit }) => {
      const repositoryPath = await gitRepository(directory, repository)
      if (!repositoryPath) return { commits: [] }
      const text = await gitText(
        ["log", `-${Math.min(Math.max(Math.floor(limit), 1), 50)}`, "--format=%h%x09%an%x09%ar%x09%s"],
        repositoryPath,
      )
      return { commits: parseGitLog(text) }
    },

    preCommitStatus: async ({ directory, repository, scope }) => {
      const path = await gitRepository(directory, repository)
      if (!path) {
        return {
          configured: false,
          oca: false,
          runner: "",
          state: "missing" as const,
          scope,
          at: 0,
          outdated: false,
        }
      }
      const info = await preCommitInfo(path)
      const last = preCommitLast.get(path)
      const digest = await repositoryDigest(path, scope)
      const sameScope = last?.scope === scope
      return {
        ...info,
        state: !info.configured
          ? ("missing" as const)
          : sameScope
            ? (last?.state ?? ("not-run" as const))
            : ("not-run" as const),
        scope: last?.scope ?? scope,
        at: sameScope ? (last?.at ?? 0) : 0,
        outdated: sameScope && digest !== "" && last.digest !== digest,
      }
    },

    preCommitRun: async ({ directory, repository, scope }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return { state: "error" as const, output: "Not a git repository", durationMs: 0 }
      const result = await runPreCommit(path, scope)
      if (result.state === "passed" || result.state === "failed") {
        preCommitLast.set(path, {
          state: result.state,
          at: Date.now(),
          digest: await repositoryDigest(path, scope),
          scope,
        })
      }
      return result
    },

    preCommitSetup: async ({ directory, repository }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      const message = await setupPreCommit(path)
      preCommitLast.delete(path)
      return message
    },

    gitSync: async ({ directory, repository, action }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      if (action === "fetch") return (await git(["fetch", "--prune"], path)) ?? "Fetched"
      const branch = await gitText(["rev-parse", "--abbrev-ref", "HEAD"], path)
      if (branch === "" || branch === "HEAD") return "Checkout a branch first"
      const upstream = await gitText(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], path)
      if (action === "pull") {
        if (upstream === "") return "This branch has no upstream to pull from"
        const counts = parseAheadBehind(
          await gitText(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], path),
        )
        if (counts.behind === 0) return "Already up to date"
        if (counts.ahead > 0)
          return `Diverged: ${counts.ahead} ahead and ${counts.behind} behind. Pull needs a manual merge or rebase`
        return (await git(["pull", "--ff-only"], path)) ?? "Pulled"
      }
      if (upstream !== "") return (await git(["push"], path)) ?? "Pushed"
      // Without an upstream, only an unambiguous remote can be chosen for the first push.
      const remotes = parseGitBranches(await gitText(["remote"], path))
      if (remotes.length === 0) return "This repository has no remote. Add one with git remote add origin <url>"
      if (remotes.length > 1) return "This branch has no upstream and the repository has several remotes"
      return (await git(["push", "-u", remotes[0] ?? "origin", branch], path)) ?? `Pushed ${branch} to ${remotes[0]}`
    },

    gitDiscard: async ({ directory, repository, paths, untracked }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      if (paths.length === 0) return "Choose the files to discard"
      const args = untracked
        ? ["clean", "-f", "-d", "--", ...paths]
        : ["restore", "--staged", "--worktree", "--", ...paths]
      return (await git(args, path)) ?? (untracked ? "Discarded untracked files" : "Discarded changes")
    },

    gitShow: async ({ directory, repository, hash }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return { stat: "", diff: "" }
      const stat = await gitText(["show", "--stat", "--format=%h%x09%an%x09%ar%n%s", hash], path)
      const diff = await gitText(["show", "--format=", "--patch", hash], path)
      return { stat: stat.slice(0, 6000), diff: diff.slice(0, 60000) }
    },

    gitContext: async ({ directory, repository }) => {
      const workspace = await resolveWorkspace(directory)
      const key = workspace?.root ?? directory
      const saved = commitContext.value[key]
      if (!saved) return { text: "", file: "", content: "" }
      const file = saved.file === "" ? "" : await contextPath(directory, repository, saved.file)
      const content =
        file === ""
          ? ""
          : (await readFile(file, "utf8").catch(() => "")).slice(0, 16000)
      return { text: saved.text, file: saved.file, content }
    },

    gitContextSet: async ({ directory, text, file }) => {
      const workspace = await resolveWorkspace(directory)
      const key = workspace?.root ?? directory
      commitContext.update((draft) => {
        draft[key] = { text, file }
      })
      return "Commit context saved"
    },

    gitContextFile: async ({ directory, repository, file }) => {
      if (file === "") return { content: "", found: false }
      const path = await contextPath(directory, repository, file)
      const content = await readFile(path, "utf8").catch(() => undefined)
      return { content: (content ?? "").slice(0, 16000), found: content !== undefined }
    },

    gitStage: async ({ directory, repository, paths }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      const args = paths.length === 0 ? ["add", "-A", "."] : ["add", "--", ...paths]
      return (await git(args, path)) ?? "Staged"
    },

    gitUnstage: async ({ directory, repository, paths }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      const args = paths.length === 0 ? ["restore", "--staged", "."] : ["restore", "--staged", "--", ...paths]
      return (await git(args, path)) ?? "Unstaged"
    },

    gitCommit: async ({ directory, repository, message }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      if (message.trim() === "") return "Write a commit message"
      return (await git(["commit", "-m", message], path)) ?? `Committed in ${repository || "the workspace"}`
    },

    gitCheckout: async ({ directory, repository, branch }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      return (await git(["checkout", branch], path)) ?? `On ${branch}`
    },

    gitBranch: async ({ directory, repository, branch, base }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      if (branch.trim() === "") return "Write a branch name"
      return (await git(["checkout", "-b", branch, base === "" ? "HEAD" : base], path)) ?? `On ${branch}`
    },

    gitStash: async ({ directory, repository, action, index, message }) => {
      const path = await gitRepository(directory, repository)
      if (!path) return "Not a git repository"
      const reference = `stash@{${index}}`
      const args =
        action === "push"
          ? message.trim() === ""
            ? ["stash", "push"]
            : ["stash", "push", "-m", message]
          : action === "pop"
            ? ["stash", "pop", reference]
            : action === "apply"
              ? ["stash", "apply", reference]
              : ["stash", "drop", reference]
      return (await git(args, path)) ?? "Done"
    },

    adooRebuild: async ({ directory, environment, stack, name, filestore, repos, neutralize }) => {
      if (rebuildJob?.running) return { started: false, message: "A rebuild is already running" }
      const tokens = adooTokens.value
      if (!tokens) return { started: false, message: "adoo.live is not connected" }
      if (!tokens.scope.split(/\s+/).includes("database")) {
        return { started: false, message: "Reconnect adoo.live to grant the database scope that pulls need" }
      }
      const workspace = await resolveWorkspace(directory)
      if (!workspace) return { started: false, message: "No Odoo workspace found for this directory" }
      const job: RebuildJob = {
        running: true,
        environment,
        step: "",
        message: "",
        database: "",
        bytes: 0,
        totalBytes: 0,
        startedAt: Date.now(),
      }
      rebuildJob = job
      void runRebuild(job, workspace, environment, stack, name, filestore, repos, neutralize)
      return { started: true, message: "" }
    },

    adooRebuildStatus: async () => {
      const job = rebuildJob
      return {
        running: job?.running ?? false,
        environment: job?.environment ?? "",
        step: job?.step ?? ("" as const),
        message: job?.message ?? "",
        database: job?.database ?? "",
        bytes: job?.bytes ?? 0,
        totalBytes: job?.totalBytes ?? 0,
        startedAt: job?.startedAt ?? 0,
      }
    },

    rpcList: async () => {
      const path = credentialsPath()
      const saved = parseSavedConnections(await readFile(path, "utf8").catch(() => ""))
      return {
        path,
        connections: Object.entries(saved).map(([name, value]) => ({
          name,
          url: value.url,
          database: value.database,
          username: value.username,
          enabled: value.enabled,
          writes: value.writes,
        })),
      }
    },

    rpcSave: async ({ name, url, database, username, password, enabled, writes }) => {
      const path = credentialsPath()
      const saved = parseSavedConnections(await readFile(path, "utf8").catch(() => ""))
      const secret = password !== "" ? password : (saved[name]?.password ?? "")
      if (secret === "") throw new Error("A password or API key is required")
      const clean = url.trim().replace(/\/+$/, "")
      const next = {
        ...saved,
        [name]: { url: clean, database, username, password: secret, enabled, writes },
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await chmod(path, 0o600)
      return { name, url: clean, database, username, enabled, writes }
    },

    rpcRemove: async ({ name }) => {
      const path = credentialsPath()
      const saved = parseSavedConnections(await readFile(path, "utf8").catch(() => ""))
      if (!(name in saved)) return `No connection named ${name}`
      const next = Object.fromEntries(Object.entries(saved).filter(([key]) => key !== name))
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await chmod(path, 0o600)
      return `Removed ${name}`
    },
  })
}

export default setup
