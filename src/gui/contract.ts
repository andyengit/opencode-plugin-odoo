import { Schema } from "effect"
import { Ipc, type IpcClient } from "@opencode/plugin/gui"

export const WorkspaceSummary = Schema.Struct({
  root: Schema.String,
  versions: Schema.Array(Schema.Struct({ name: Schema.String, series: Schema.String })),
  environments: Schema.Array(Schema.String),
  activeEnvironment: Schema.String,
  environmentVersion: Schema.String,
  activeHttpPort: Schema.String,
  dockerCompose: Schema.String,
  venv: Schema.String,
})
export type WorkspaceSummary = typeof WorkspaceSummary.Type

export const WorkspaceStatus = Schema.Struct({
  postgres: Schema.Literals(["running", "unhealthy", "stopped", "none"]),
  environments: Schema.Array(Schema.Struct({ label: Schema.String, running: Schema.Boolean })),
})
export type WorkspaceStatus = typeof WorkspaceStatus.Type

export const AdooItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  detail: Schema.String,
  url: Schema.String,
  database: Schema.String,
  stack: Schema.String,
  type: Schema.String,
})
export type AdooItem = typeof AdooItem.Type

export const AdooStatus = Schema.Struct({
  state: Schema.Literals(["disconnected", "pending", "connected", "denied", "expired", "error"]),
  userCode: Schema.String,
  verificationUri: Schema.String,
  message: Schema.String,
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
  scope: Schema.String,
  expiresAt: Schema.Number,
})
export type AdooStatus = typeof AdooStatus.Type

export const AdooData = Schema.Struct({
  connected: Schema.Boolean,
  forbidden: Schema.Boolean,
  email: Schema.String,
  name: Schema.String,
  role: Schema.String,
  environments: Schema.Array(AdooItem),
})
export type AdooData = typeof AdooData.Type

export const AdooSyncRepo = Schema.Struct({
  path: Schema.String,
  state: Schema.Literals(["pending", "clone", "pull", "done", "skipped", "error"]),
  message: Schema.String,
})

export const AdooSyncStatus = Schema.Struct({
  running: Schema.Boolean,
  environment: Schema.String,
  done: Schema.Number,
  total: Schema.Number,
  repos: Schema.Array(AdooSyncRepo),
})
export type AdooSyncStatus = typeof AdooSyncStatus.Type

export const AdooRepo = Schema.Struct({
  path: Schema.String,
  branch: Schema.String,
  commit: Schema.String,
  local: Schema.String,
  localBranch: Schema.String,
  changed: Schema.Number,
  state: Schema.Literals(["same", "different", "missing", "unknown", "error"]),
  message: Schema.String,
  requirements: Schema.Number,
  missing: Schema.Array(Schema.String),
})
export type AdooRepo = typeof AdooRepo.Type

export const RepoChanges = Schema.Struct({
  branch: Schema.String,
  files: Schema.Array(Schema.Struct({ code: Schema.String, path: Schema.String })),
  diff: Schema.String,
})
export type RepoChanges = typeof RepoChanges.Type

export const GitRepo = Schema.Struct({
  path: Schema.String,
  changed: Schema.Number,
})

export const GitFile = Schema.Struct({
  path: Schema.String,
  code: Schema.String,
  staged: Schema.Boolean,
  worktree: Schema.Boolean,
  untracked: Schema.Boolean,
})
export type GitFile = typeof GitFile.Type

export const GitStash = Schema.Struct({
  index: Schema.Number,
  message: Schema.String,
})

export const GitCommit = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
})

export const GitState = Schema.Struct({
  branch: Schema.String,
  head: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
  branches: Schema.Array(Schema.String),
  files: Schema.Array(GitFile),
  stash: Schema.Array(GitStash),
})
export type GitState = typeof GitState.Type

export const InstallStatus = Schema.Struct({
  running: Schema.Boolean,
  version: Schema.String,
  step: Schema.Literals(["", "clone", "venv", "requirements", "done", "error"]),
  message: Schema.String,
  startedAt: Schema.Number,
})
export type InstallStatus = typeof InstallStatus.Type

export const PythonStatus = Schema.Struct({
  running: Schema.Boolean,
  version: Schema.String,
  packages: Schema.String,
  message: Schema.String,
  startedAt: Schema.Number,
})
export type PythonStatus = typeof PythonStatus.Type

export const AddonsItem = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  requirements: Schema.Number,
  missing: Schema.Array(Schema.String),
})

export const AddonsState = Schema.Struct({
  active: Schema.Array(AddonsItem),
  available: Schema.Array(AddonsItem),
})
export type AddonsState = typeof AddonsState.Type

export const RpcConnectionInfo = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  database: Schema.String,
  username: Schema.String,
  enabled: Schema.Boolean,
  writes: Schema.Boolean,
})
export type RpcConnectionInfo = typeof RpcConnectionInfo.Type

export const RebuildStatus = Schema.Struct({
  running: Schema.Boolean,
  environment: Schema.String,
  step: Schema.Literals([
    "",
    "generate",
    "wait",
    "download",
    "create",
    "restore",
    "filestore",
    "neutralize",
    "repos",
    "done",
    "error",
  ]),
  message: Schema.String,
  database: Schema.String,
  bytes: Schema.Number,
  totalBytes: Schema.Number,
  startedAt: Schema.Number,
})
export type RebuildStatus = typeof RebuildStatus.Type

export const Odoo = Ipc.define({
  id: "odoo",
  methods: {
    detect: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.NullOr(WorkspaceSummary),
    },
    setEnvironment: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String }),
    },
    status: {
      input: Schema.Struct({ directory: Schema.String }),
      output: WorkspaceStatus,
    },
    create: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.String,
    },
    createConf: {
      input: Schema.Struct({ directory: Schema.String, name: Schema.String, version: Schema.String }),
      output: Schema.String,
    },
    fixPorts: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.String,
    },
    deleteConf: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String }),
      output: Schema.String,
    },
    launch: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String }),
      output: Schema.NullOr(
        Schema.Struct({
          command: Schema.String,
          args: Schema.Array(Schema.String),
          cwd: Schema.String,
        }),
      ),
    },
    log: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String }),
      output: Schema.String,
    },
    confValues: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String }),
      output: Schema.Struct({
        db_host: Schema.String,
        db_port: Schema.String,
        db_user: Schema.String,
        db_password: Schema.String,
        http_port: Schema.String,
        workers: Schema.String,
        max_cron_threads: Schema.String,
        limit_time_cpu: Schema.String,
        limit_time_real: Schema.String,
        log_level: Schema.String,
      }),
    },
    confSet: {
      input: Schema.Struct({
        directory: Schema.String,
        label: Schema.String,
        key: Schema.String,
        value: Schema.String,
      }),
      output: Schema.String,
    },
    confExtra: {
      input: Schema.Struct({
        directory: Schema.String,
        label: Schema.String,
        text: Schema.String,
      }),
      output: Schema.String,
    },
    install: {
      input: Schema.Struct({ directory: Schema.String, version: Schema.String, conf: Schema.String }),
      output: Schema.Struct({ started: Schema.Boolean, message: Schema.String }),
    },
    installStatus: {
      input: Schema.Struct({}),
      output: InstallStatus,
    },
    pythonInstall: {
      input: Schema.Struct({
        directory: Schema.String,
        version: Schema.String,
        packages: Schema.String,
      }),
      output: Schema.Struct({ started: Schema.Boolean, message: Schema.String }),
    },
    pythonInstallStatus: {
      input: Schema.Struct({}),
      output: PythonStatus,
    },
    addons: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String }),
      output: AddonsState,
    },
    addonsToggle: {
      input: Schema.Struct({
        directory: Schema.String,
        label: Schema.String,
        path: Schema.String,
        enabled: Schema.Boolean,
      }),
      output: AddonsState,
    },
    addonsDeps: {
      input: Schema.Struct({ directory: Schema.String, label: Schema.String, path: Schema.String }),
      output: Schema.Struct({ started: Schema.Boolean, message: Schema.String }),
    },
    postgres: {
      input: Schema.Struct({
        directory: Schema.String,
        action: Schema.Literals(["up", "down", "restart", "status"]),
      }),
      output: Schema.String,
    },
    odoo: {
      input: Schema.Struct({
        directory: Schema.String,
        label: Schema.String,
        action: Schema.Literals(["start", "stop", "restart"]),
      }),
      output: Schema.String,
    },
    odooCli: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.Struct({
        launcher: Schema.String,
        state: Schema.String,
        target: Schema.String,
        installed: Schema.Boolean,
        current: Schema.String,
      }),
    },
    odooCliInstall: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.String,
    },
    adooStatus: {
      input: Schema.Struct({}),
      output: AdooStatus,
    },
    adooStart: {
      input: Schema.Struct({}),
      output: Schema.Struct({
        userCode: Schema.String,
        verificationUri: Schema.String,
        expiresIn: Schema.Number,
        interval: Schema.Number,
      }),
    },
    adooLogout: {
      input: Schema.Struct({}),
      output: Schema.String,
    },
    adooData: {
      input: Schema.Struct({}),
      output: AdooData,
    },
    adooDatabase: {
      input: Schema.Struct({ environment: Schema.String }),
      output: Schema.Struct({ database: Schema.String }),
    },
    adooSync: {
      input: Schema.Struct({
        directory: Schema.String,
        stack: Schema.String,
        environment: Schema.String,
      }),
      output: Schema.Struct({ started: Schema.Boolean, message: Schema.String }),
    },
    adooSyncStatus: {
      input: Schema.Struct({}),
      output: AdooSyncStatus,
    },
    adooRepos: {
      input: Schema.Struct({ directory: Schema.String, environment: Schema.String }),
      output: Schema.Struct({ message: Schema.String, venv: Schema.String, repos: Schema.Array(AdooRepo) }),
    },
    repoChanges: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String }),
      output: RepoChanges,
    },
    gitRepos: {
      input: Schema.Struct({ directory: Schema.String }),
      output: Schema.Struct({ repos: Schema.Array(GitRepo) }),
    },
    gitState: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String }),
      output: GitState,
    },
    gitStage: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String, paths: Schema.Array(Schema.String) }),
      output: Schema.String,
    },
    gitUnstage: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String, paths: Schema.Array(Schema.String) }),
      output: Schema.String,
    },
    gitCommit: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String, message: Schema.String }),
      output: Schema.String,
    },
    gitCheckout: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String, branch: Schema.String }),
      output: Schema.String,
    },
    gitBranch: {
      input: Schema.Struct({
        directory: Schema.String,
        repository: Schema.String,
        branch: Schema.String,
        base: Schema.String,
      }),
      output: Schema.String,
    },
    gitStash: {
      input: Schema.Struct({
        directory: Schema.String,
        repository: Schema.String,
        action: Schema.Literals(["push", "pop", "apply", "drop"]),
        index: Schema.Number,
        message: Schema.String,
      }),
      output: Schema.String,
    },
    gitDiff: {
      input: Schema.Struct({
        directory: Schema.String,
        repository: Schema.String,
        path: Schema.String,
        staged: Schema.Boolean,
      }),
      output: Schema.Struct({ diff: Schema.String }),
    },
    gitStagedDiff: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String }),
      output: Schema.Struct({ diff: Schema.String }),
    },
    gitUndo: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String, count: Schema.Number }),
      output: Schema.String,
    },
    gitLog: {
      input: Schema.Struct({ directory: Schema.String, repository: Schema.String, limit: Schema.Number }),
      output: Schema.Struct({ commits: Schema.Array(GitCommit) }),
    },
    adooRebuild: {
      input: Schema.Struct({
        directory: Schema.String,
        environment: Schema.String,
        stack: Schema.String,
        name: Schema.String,
        filestore: Schema.Boolean,
        repos: Schema.Boolean,
        neutralize: Schema.Boolean,
      }),
      output: Schema.Struct({ started: Schema.Boolean, message: Schema.String }),
    },
    adooRebuildStatus: {
      input: Schema.Struct({}),
      output: RebuildStatus,
    },
    rpcList: {
      input: Schema.Struct({}),
      output: Schema.Struct({ path: Schema.String, connections: Schema.Array(RpcConnectionInfo) }),
    },
    rpcRemove: {
      input: Schema.Struct({ name: Schema.String }),
      output: Schema.String,
    },
    rpcSave: {
      input: Schema.Struct({
        name: Schema.String,
        url: Schema.String,
        database: Schema.String,
        username: Schema.String,
        password: Schema.String,
        enabled: Schema.Boolean,
        writes: Schema.Boolean,
      }),
      output: RpcConnectionInfo,
    },
  },
})

export type OdooClient = IpcClient<typeof Odoo.spec>
