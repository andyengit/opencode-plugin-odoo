import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import type {
  AdooData,
  AdooItem,
  AdooStatus,
  AdooSyncStatus,
  AddonsState,
  InstallStatus,
  OdooClient,
  PythonStatus,
  RebuildStatus,
  RepoChanges,
  WorkspaceStatus,
  WorkspaceSummary,
} from "./contract"
import { LogView } from "./log"

const GREEN = "#22c55e"
const AMBER = "#f59e0b"
const GRAY = "#6b7280"

const CONF_KEYS = [
  "db_host",
  "db_port",
  "db_user",
  "db_password",
  "http_port",
  "workers",
  "max_cron_threads",
  "limit_time_cpu",
  "limit_time_real",
  "log_level",
] as const

/** The Odoo series the panel offers to install. */
const ODOO_VERSIONS = ["15.0", "16.0", "17.0", "18.0", "19.0", "20.0"]

const CONF_DEFAULTS: Record<(typeof CONF_KEYS)[number], string> = {
  db_host: "localhost",
  db_port: "5432",
  db_user: "odoo",
  db_password: "odoo",
  http_port: "8069",
  workers: "0",
  max_cron_threads: "2",
  limit_time_cpu: "60",
  limit_time_real: "120",
  log_level: "info",
}

function postgresColor(state: WorkspaceStatus["postgres"] | undefined): string {
  if (state === "running") return GREEN
  if (state === "unhealthy") return AMBER
  return GRAY
}

export default function OdooControls(props: { odoo: OdooClient; directory: string }) {
  const ctx = usePlugin()
  const [summary, setSummary] = createSignal<WorkspaceSummary | null | undefined>(undefined)
  const [status, setStatus] = createSignal<WorkspaceStatus | undefined>(undefined)
  const [busy, setBusy] = createSignal<string | undefined>()
  const [version, setVersion] = createSignal("18.0")
  const [openValues, setOpenValues] = createSignal(false)
  const [openText, setOpenText] = createSignal(false)
  const [openAdoo, setOpenAdoo] = createSignal(false)
  const [openPython, setOpenPython] = createSignal(false)
  const [openAddons, setOpenAddons] = createSignal(false)
  const [openConnections, setOpenConnections] = createSignal(false)
  const [revision, setRevision] = createSignal(0)
  const [installStatus, setInstallStatus] = createSignal<InstallStatus | undefined>()

  const loadStatus = () =>
    void props.odoo
      .status({ directory: props.directory })
      .then(setStatus)
      .catch(() => undefined)

  const load = async () => {
    const next = await props.odoo.detect({ directory: props.directory }).catch(() => null)
    setSummary(next)
    loadStatus()
  }

  const loadInstall = () =>
    void props.odoo
      .installStatus({})
      .then(setInstallStatus)
      .catch(() => undefined)

  createKeyed(
    () => installStatus()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(loadInstall, 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  let wasInstalling = false
  createEffect(() => {
    const value = installStatus()
    if (wasInstalling && value && !value.running) {
      if (value.step === "error")
        ctx.toast.show({ title: ctx.t("installFailed"), description: value.message, variant: "error" })
      else ctx.toast.show({ title: value.message || ctx.t("installDone"), variant: "success" })
      void load()
    }
    wasInstalling = value?.running ?? false
  })

  // The panel stays mounted while the routed session changes, so follow its directory and keep the
  // detection fresh without a manual refresh.
  createKeyed(
    () => props.directory,
    () => {
      setSummary(undefined)
      setStatus(undefined)
      void load()
    },
  )

  onMount(() => {
    loadInstall()
    const timer = setInterval(() => void load(), 5000)
    onCleanup(() => clearInterval(timer))
  })

  const run = async (key: string, fn: () => Promise<string | undefined>) => {
    setBusy(key)
    const outcome = await fn().then(
      (message) => ({ message }),
      (error: unknown) => ({ message: String(error) }),
    )
    if (outcome.message) ctx.toast.show({ title: outcome.message })
    setBusy(undefined)
    await load()
  }

  const postgres = (action: "up" | "down" | "restart") => props.odoo.postgres({ directory: props.directory, action })
  const odoo = (label: string, action: "start" | "stop" | "restart") =>
    props.odoo.odoo({ directory: props.directory, label, action })

  const installStep = () => {
    const step = installStatus()?.step
    if (step === "clone") return ctx.t("installCloning")
    if (step === "venv") return ctx.t("installVenv")
    if (step === "requirements") return ctx.t("installRequirements")
    if (step === "done") return ctx.t("installDone")
    if (step === "error") return ctx.t("installFailed")
    return ctx.t("loading")
  }

  const installElapsed = () => {
    const value = installStatus()
    if (!value?.startedAt) return 0
    return Math.max(0, Math.round((Date.now() - value.startedAt) / 1000))
  }

  const openInstall = () => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("installOdoo")}
        description={`bin/odoo-${(installStatus()?.version || version()).split(".")[0]}`}
        size="normal"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <InstallProgress odoo={props.odoo} />
      </ctx.ui.Dialog>
    ))
  }

  const startInstall = async () => {
    const target = version()
    setBusy("install")
    const result = await props.odoo
      .install({ directory: props.directory, version: target, conf: "" })
      .catch((error: unknown) => ({ started: false, message: String(error) }))
    setBusy(undefined)
    if (!result.started) {
      ctx.toast.show({ title: result.message, variant: "error" })
      return
    }
    loadInstall()
    openInstall()
  }

  const state = () => status()?.postgres
  const stateLabel = () => {
    const value = state()
    if (value === "running") return ctx.t("running")
    if (value === "unhealthy") return ctx.t("unhealthy")
    if (value === "stopped") return ctx.t("stopped")
    return ctx.t("none")
  }
  const odooRunning = (label: string) => status()?.environments.find((item) => item.label === label)?.running ?? false
  const pgActive = () => state() === "running" || state() === "unhealthy"

  const newConfig = (workspace: WorkspaceSummary) => {
    const choices = () => {
      const entries: Array<{ value: string; label: string }> = []
      for (const series of ODOO_VERSIONS) {
        const installed = workspace.versions.find((item) => item.series === series)
        entries.push(
          installed
            ? { value: installed.name, label: series }
            : { value: `install:${series}`, label: `${series} (${ctx.t("installOption")})` },
        )
      }
      for (const item of workspace.versions) {
        if (!ODOO_VERSIONS.includes(item.series)) entries.push({ value: item.name, label: item.series })
      }
      return entries
    }
    const [name, setName] = createSignal("")
    const [version, setVersion] = createSignal(
      workspace.environmentVersion || workspace.versions[0]?.name || "install:18.0",
    )
    const create = () => {
      const chosen = name().trim()
      if (chosen === "") return
      const target = version()
      const series = target.startsWith("install:") ? target.slice("install:".length) : ""
      void (async () => {
        await run("newconf", () =>
          props.odoo.createConf({ directory: props.directory, name: chosen, version: series ? "" : target }),
        )
        if (series === "") return
        const result = await props.odoo
          .install({ directory: props.directory, version: series, conf: chosen })
          .catch((error: unknown) => ({ started: false, message: String(error) }))
        if (!result.started) {
          ctx.toast.show({ title: result.message, variant: "error" })
          return
        }
        loadInstall()
        openInstall()
      })()
    }
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("newConfig")}
        footer={
          <>
            <ctx.ui.Button variant="ghost" onClick={dialog.close}>
              {ctx.t("cancel")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="contrast"
              disabled={name().trim() === ""}
              onClick={() => {
                dialog.close()
                create()
              }}
            >
              {ctx.t("create")}
            </ctx.ui.Button>
          </>
        }
      >
        <div class="flex flex-col gap-3">
          <ctx.ui.TextInput label={ctx.t("configName")} value={name()} onInput={setName} placeholder="demo" />
          <ctx.ui.Select
            label={ctx.t("version")}
            options={choices()}
            value={version() || undefined}
            onChange={setVersion}
          />
        </div>
      </ctx.ui.Dialog>
    ))
  }

  return (
    <div class="flex flex-col gap-2 p-3 min-h-0 overflow-y-auto">
      <div class="flex items-center justify-end gap-1">
        <ctx.ui.Button
          size="small"
          variant="ghost"
          busy={busy() === "ports"}
          onClick={() => run("ports", () => props.odoo.fixPorts({ directory: props.directory }))}
        >
          {ctx.t("fixPorts")}
        </ctx.ui.Button>
        <ctx.ui.Button
          size="small"
          variant="ghost"
          onClick={() =>
            ctx.dialogs.open((dialog) => (
              <CliDialog odoo={props.odoo} directory={props.directory} close={dialog.close} />
            ))
          }
        >
          {ctx.t("cliTitle")}
        </ctx.ui.Button>
        <ctx.ui.IconButton
          icon="outline-rotate-clockwise"
          label={ctx.t("refresh")}
          size="small"
          onClick={() => void load()}
        />
      </div>

      <Show when={summary() === undefined}>
        <span class="text-xs opacity-60 px-1">{ctx.t("loading")}</span>
      </Show>

      <Show when={summary() === null}>
        <div class="flex flex-col gap-2 p-1">
          <span class="text-xs opacity-60">{ctx.t("noWorkspace")}</span>
          <ctx.ui.Button
            size="small"
            variant="contrast"
            busy={busy() === "create"}
            onClick={() => run("create", () => props.odoo.create({ directory: props.directory }))}
          >
            {ctx.t("create")}
          </ctx.ui.Button>
        </div>
      </Show>

      <Show when={summary()}>
        {(workspace) => {
          const active = () => workspace().activeEnvironment || workspace().environments[0] || ""
          const deleteConfig = async () => {
            const label = active()
            if (!label) return
            const ok = await ctx.dialogs.confirm({
              title: ctx.t("deleteConfig"),
              description: label,
              confirm: ctx.t("delete"),
              danger: true,
            })
            if (ok) await run("delconf", () => props.odoo.deleteConf({ directory: props.directory, label }))
          }
          return (
            <div class="flex flex-col gap-2">
              <div class="text-[11px] opacity-50 px-1 truncate">{workspace().root}</div>

              <Show when={installStatus()?.running}>
                <div class="flex items-center gap-1">
                  <span class="text-xs opacity-70 flex-1 truncate">
                    {`${installStatus()?.version ?? ""} · ${installStep()} · ${installElapsed()}s`}
                  </span>
                  <ctx.ui.Button size="small" variant="ghost" onClick={openInstall}>
                    {ctx.t("progress")}
                  </ctx.ui.Button>
                </div>
              </Show>

              <Show when={workspace().dockerCompose}>
                <div class="flex items-center gap-1">
                  <span
                    class="inline-block w-2 h-2 rounded-full shrink-0"
                    style={{ "background-color": postgresColor(state()) }}
                  />
                  <span class="text-xs opacity-70 flex-1 px-1">
                    {ctx.t("postgres")} · {stateLabel()}
                  </span>
                  <Show
                    when={pgActive()}
                    fallback={
                      <ctx.ui.IconButton
                        icon="chevron-right"
                        label={ctx.t("start")}
                        size="small"
                        variant="ghost"
                        busy={busy() === "pg-up"}
                        onClick={() => run("pg-up", () => postgres("up"))}
                      />
                    }
                  >
                    <ctx.ui.IconButton
                      icon="stop"
                      label={ctx.t("stop")}
                      size="small"
                      variant="ghost"
                      busy={busy() === "pg-down"}
                      onClick={() => run("pg-down", () => postgres("down"))}
                    />
                    <ctx.ui.IconButton
                      icon="outline-rotate-clockwise"
                      label={ctx.t("restart")}
                      size="small"
                      variant="ghost"
                      busy={busy() === "pg-restart"}
                      onClick={() => run("pg-restart", () => postgres("restart"))}
                    />
                  </Show>
                </div>
              </Show>

              <Show
                when={workspace().versions.length > 0}
                fallback={
                  <div class="flex flex-col gap-2 p-1">
                    <span class="text-[11px] opacity-50">{ctx.t("noOdooSource")}</span>
                    <div class="flex items-center gap-1">
                      <ctx.ui.Select
                        options={ODOO_VERSIONS.map((item) => ({ value: item, label: item }))}
                        value={version()}
                        onChange={setVersion}
                        label={ctx.t("version")}
                        class="flex-1"
                      />
                      <ctx.ui.Button
                        size="small"
                        variant="contrast"
                        busy={busy() === "install" || installStatus()?.running === true}
                        onClick={() => void startInstall()}
                      >
                        {ctx.t("installOdoo")}
                      </ctx.ui.Button>
                    </div>
                  </div>
                }
              >
                <span class="flex items-center gap-1 text-[11px] opacity-50 px-1 text-left">
                  <ctx.ui.Icon name="file-document" size="small" />
                  {ctx.t("environment")}
                </span>
                <div class="flex items-center gap-1">
                  <Show
                    when={workspace().environments.length > 1}
                    fallback={
                      <span class="text-xs opacity-70 flex-1 px-1 truncate">{active() || ctx.t("noConfig")}</span>
                    }
                  >
                    <ctx.ui.Select
                      options={workspace().environments.map((label) => ({ value: label, label }))}
                      value={active() || undefined}
                      onChange={(label) =>
                        void props.odoo.setEnvironment({ directory: props.directory, label }).then(() => load())
                      }
                      label={ctx.t("environment")}
                      class="flex-1"
                    />
                  </Show>
                  <ctx.ui.IconButton
                    icon="plus"
                    label={ctx.t("newConfig")}
                    size="small"
                    variant="ghost"
                    busy={busy() === "newconf"}
                    onClick={() => newConfig(workspace())}
                  />
                  <ctx.ui.IconButton
                    icon="trash"
                    label={ctx.t("deleteConfig")}
                    size="small"
                    variant="ghost"
                    disabled={!active()}
                    busy={busy() === "delconf"}
                    onClick={() => void deleteConfig()}
                  />
                </div>

                <Show when={active()}>
                  {(label) => {
                    const series = () =>
                      workspace().versions.find((item) => item.name === workspace().environmentVersion)?.series ??
                      workspace().environmentVersion
                    return (
                      <div class="flex items-center gap-1">
                        <span
                          class="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ "background-color": odooRunning(label()) ? GREEN : GRAY }}
                        />
                        <span class="text-xs opacity-70 flex-1 px-1 truncate">{label()}</span>
                        <Show when={series()}>
                          <span class="text-[11px] opacity-50 px-1 shrink-0">{series()}</span>
                        </Show>
                        <Show
                          when={odooRunning(label())}
                          fallback={
                            <ctx.ui.IconButton
                              icon="chevron-right"
                              label={ctx.t("start")}
                              size="small"
                              variant="ghost"
                              busy={busy() === `${label()}-start`}
                              onClick={() => run(`${label()}-start`, () => odoo(label(), "start"))}
                            />
                          }
                        >
                          <ctx.ui.IconButton
                            icon="stop"
                            label={ctx.t("stop")}
                            size="small"
                            variant="ghost"
                            busy={busy() === `${label()}-stop`}
                            onClick={() => run(`${label()}-stop`, () => odoo(label(), "stop"))}
                          />
                          <ctx.ui.IconButton
                            icon="outline-rotate-clockwise"
                            label={ctx.t("restart")}
                            size="small"
                            variant="ghost"
                            busy={busy() === `${label()}-restart`}
                            onClick={() => run(`${label()}-restart`, () => odoo(label(), "restart"))}
                          />
                        </Show>
                        <ctx.ui.IconButton
                          icon="console"
                          label={ctx.t("log")}
                          size="small"
                          variant="ghost"
                          onClick={() =>
                            ctx.dialogs.open((dialog) => (
                              <ctx.ui.Dialog
                                title={ctx.t("log")}
                                description={label()}
                                size="x-large"
                                footer={
                                  <ctx.ui.Button variant="contrast" onClick={dialog.close}>
                                    {ctx.t("close")}
                                  </ctx.ui.Button>
                                }
                              >
                                <LogView odoo={props.odoo} directory={props.directory} label={label()} />
                              </ctx.ui.Dialog>
                            ))
                          }
                        />
                        <Show when={workspace().activeHttpPort}>
                          <ctx.ui.Button
                            size="small"
                            variant="ghost"
                            class="justify-start"
                            icon="globe"
                            onClick={() => ctx.system.openExternal(`http://localhost:${workspace().activeHttpPort}`)}
                          >
                            {`http://localhost:${workspace().activeHttpPort}`}
                          </ctx.ui.Button>
                        </Show>
                      </div>
                    )
                  }}
                </Show>

                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  class="justify-start"
                  onClick={() => setOpenValues(!openValues())}
                >
                  <span class="flex items-center gap-1 w-full">
                    <ctx.ui.Icon name="outline-sliders" size="small" />
                    {ctx.t("values")}
                    <span class="flex-1" />
                    <ctx.ui.Icon name={openValues() ? "chevron-down" : "chevron-right"} size="small" />
                  </span>
                </ctx.ui.Button>
                <Show when={openValues() && active()}>
                  {(label) => (
                    <ConfValues odoo={props.odoo} directory={props.directory} label={label()} revision={revision()} />
                  )}
                </Show>

                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  class="justify-start"
                  onClick={() => setOpenText(!openText())}
                >
                  <span class="flex items-center gap-1 w-full">
                    <ctx.ui.Icon name="code-lines" size="small" />
                    {ctx.t("extraConfig")}
                    <span class="flex-1" />
                    <ctx.ui.Icon name={openText() ? "chevron-down" : "chevron-right"} size="small" />
                  </span>
                </ctx.ui.Button>
                <Show when={openText() && active()}>
                  {(label) => (
                    <ConfExtra
                      odoo={props.odoo}
                      directory={props.directory}
                      label={label()}
                      onSaved={() => {
                        setRevision(revision() + 1)
                        void load()
                      }}
                    />
                  )}
                </Show>

                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  class="justify-start"
                  onClick={() => setOpenAddons(!openAddons())}
                >
                  <span class="flex items-center gap-1 w-full">
                    <ctx.ui.Icon name="folder" size="small" />
                    {ctx.t("addons")}
                    <span class="flex-1" />
                    <ctx.ui.Icon name={openAddons() ? "chevron-down" : "chevron-right"} size="small" />
                  </span>
                </ctx.ui.Button>
                <Show when={openAddons() && active()}>
                  {(label) => (
                    <AddonsPaths
                      odoo={props.odoo}
                      directory={props.directory}
                      label={label()}
                      root={workspace().root}
                    />
                  )}
                </Show>

                <Show when={workspace().versions.length > 0 && workspace().environmentVersion}>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    class="justify-start"
                    onClick={() => setOpenPython(!openPython())}
                  >
                    <span class="flex items-center gap-1 w-full">
                      <ctx.ui.Icon name="cube" size="small" />
                      {ctx.t("pythonPackages")}
                      <span class="flex-1" />
                      <ctx.ui.Icon name={openPython() ? "chevron-down" : "chevron-right"} size="small" />
                    </span>
                  </ctx.ui.Button>
                  <Show when={openPython()}>
                    <PythonPackages
                      odoo={props.odoo}
                      directory={props.directory}
                      version={workspace().environmentVersion}
                    />
                  </Show>
                </Show>

                <ctx.ui.Button
                  size="small"
                  variant="ghost"
                  class="justify-start"
                  onClick={() => setOpenAdoo(!openAdoo())}
                >
                  <span class="flex items-center gap-1 w-full">
                    <ctx.ui.Icon name="globe" size="small" />
                    {ctx.t("adoo")}
                    <span class="flex-1" />
                    <ctx.ui.Icon name={openAdoo() ? "chevron-down" : "chevron-right"} size="small" />
                  </span>
                </ctx.ui.Button>
                <Show when={openAdoo()}>
                  <AdooAccount odoo={props.odoo} directory={props.directory} />
                </Show>
              </Show>
            </div>
          )
        }}
      </Show>

      <ctx.ui.Button
        size="small"
        variant="ghost"
        class="justify-start"
        onClick={() => setOpenConnections(!openConnections())}
      >
        <span class="flex items-center gap-1 w-full">
          <ctx.ui.Icon name="lock" size="small" />
          {ctx.t("rpcConnections")}
          <span class="flex-1" />
          <ctx.ui.Icon name={openConnections() ? "chevron-down" : "chevron-right"} size="small" />
        </span>
      </ctx.ui.Button>
      <Show when={openConnections()}>
        <RpcConnections odoo={props.odoo} />
      </Show>
    </div>
  )
}

function ConfValues(props: { odoo: OdooClient; directory: string; label: string; revision: number }) {
  const ctx = usePlugin()
  const [values, setValues] = createSignal<Record<string, string>>({})
  const [saving, setSaving] = createSignal<string | undefined>()

  const load = () =>
    void props.odoo
      .confValues({ directory: props.directory, label: props.label })
      .then((next) => setValues({ ...next }))
      .catch(() => setValues({}))

  createEffect(() => {
    props.revision
    load()
  })

  const save = async (key: string, value: string) => {
    setSaving(key)
    const message = await props.odoo
      .confSet({ directory: props.directory, label: props.label, key, value })
      .catch((error: unknown) => String(error))
    if (message) ctx.toast.show({ title: message })
    setSaving(undefined)
    load()
  }

  return (
    <div class="flex flex-col gap-2">
      <span class="text-[11px] opacity-50 px-1">{ctx.t("valuesHint")}</span>
      <For each={CONF_KEYS}>
        {(key) => (
          <div class="flex items-center gap-1">
            <span class="text-xs opacity-60 w-24 shrink-0">{key}</span>
            <ctx.ui.TextInput
              value={values()[key] ?? ""}
              onInput={(value) => setValues({ ...values(), [key]: value })}
              onSubmit={(value) => void save(key, value)}
              type={key === "db_password" ? "password" : "text"}
              label={key}
              placeholder={CONF_DEFAULTS[key]}
              class="flex-1"
            />
            <ctx.ui.IconButton
              icon="check"
              label={ctx.t("save")}
              size="small"
              variant="ghost"
              busy={saving() === key}
              onClick={() => void save(key, values()[key] ?? "")}
            />
          </div>
        )}
      </For>
    </div>
  )
}

function ConfExtra(props: { odoo: OdooClient; directory: string; label: string; onSaved: () => void }) {
  const ctx = usePlugin()
  const [text, setText] = createSignal("")
  const [saving, setSaving] = createSignal(false)

  const save = async () => {
    setSaving(true)
    const message = await props.odoo
      .confExtra({ directory: props.directory, label: props.label, text: text() })
      .catch((error: unknown) => String(error))
    if (message) ctx.toast.show({ title: message })
    setSaving(false)
    setText("")
    props.onSaved()
  }

  return (
    <div class="flex flex-col gap-2">
      <span class="text-[11px] opacity-50 px-1">{ctx.t("extraHint")}</span>
      <textarea
        class="w-full min-h-24 p-2 text-[12px] rounded-md resize-y outline-none"
        style={{
          "font-family": "var(--font-family-mono, monospace)",
          "background-color": "var(--v2-background-bg-base, transparent)",
          color: "var(--v2-text-text-base, inherit)",
          "box-shadow": "var(--v2-elevation-input, inset 0 0 0 1px #8884)",
        }}
        value={text()}
        spellcheck={false}
        placeholder={"workers = 2\ndev = all"}
        onInput={(event) => setText(event.currentTarget.value)}
      />
      <div class="flex items-center gap-1">
        <ctx.ui.Button
          size="small"
          variant="contrast"
          busy={saving()}
          disabled={text().trim() === ""}
          onClick={() => void save()}
        >
          {ctx.t("add")}
        </ctx.ui.Button>
        <span class="text-[11px] opacity-50 flex-1 px-1 truncate">{`${props.label}.conf`}</span>
      </div>
    </div>
  )
}

function AdooAccount(props: { odoo: OdooClient; directory: string }) {
  const ctx = usePlugin()
  const [status, setStatus] = createSignal<AdooStatus | undefined>()
  const [data, setData] = createSignal<AdooData | undefined>()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [search, setSearch] = createSignal("")
  const [expanded, setExpanded] = createSignal(false)
  const [syncStatus, setSyncStatus] = createSignal<AdooSyncStatus | undefined>()
  const [rebuildStatus, setRebuildStatus] = createSignal<RebuildStatus | undefined>()

  const loadStatus = () =>
    void props.odoo
      .adooStatus({})
      .then(setStatus)
      .catch(() => setStatus(undefined))
  const loadData = () =>
    void props.odoo
      .adooData({})
      .then(setData)
      .catch(() => setData(undefined))
  const loadSync = () =>
    void props.odoo
      .adooSyncStatus({})
      .then(setSyncStatus)
      .catch(() => undefined)
  const loadRebuild = () =>
    void props.odoo
      .adooRebuildStatus({})
      .then(setRebuildStatus)
      .catch(() => undefined)

  onMount(() => {
    loadStatus()
    loadSync()
    loadRebuild()
    const timer = setInterval(loadStatus, 8000)
    onCleanup(() => clearInterval(timer))
  })

  createKeyed(
    () => rebuildStatus()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(loadRebuild, 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  // A running sync keeps polling, so its row shows progress after the dialog is closed.
  createKeyed(
    () => syncStatus()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(loadSync, 700)
      onCleanup(() => clearInterval(timer))
    },
  )

  // Poll only while the device flow waits, and load the account once a session is connected.
  createKeyed(
    () => status()?.state,
    (state) => {
      if (state !== "pending") return
      const timer = setInterval(loadStatus, 2000)
      onCleanup(() => clearInterval(timer))
    },
  )
  createKeyed(
    () => (status()?.state === "connected" ? status()?.email : undefined),
    () => loadData(),
  )

  const connect = async () => {
    setBusy("connect")
    const device = await props.odoo.adooStart({}).catch((error: unknown) => {
      ctx.toast.show({ title: String(error) })
      return undefined
    })
    setBusy(undefined)
    if (!device) return
    ctx.system.openExternal(device.verificationUri)
    loadStatus()
  }

  const disconnect = async () => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("adooDisconnect"),
      description: ctx.t("adooDisconnectConfirm"),
      confirm: ctx.t("adooDisconnect"),
      danger: true,
    })
    if (!ok) return
    setBusy("logout")
    const message = await props.odoo.adooLogout({}).catch((error: unknown) => String(error))
    if (message) ctx.toast.show({ title: message })
    setBusy(undefined)
    setData(undefined)
    loadStatus()
  }

  const filtered = () => {
    const value = data()
    if (!value) return []
    const query = search().trim().toLowerCase()
    if (query === "") return value.environments
    return value.environments.filter((item) => `${item.label} ${item.url} ${item.type}`.toLowerCase().includes(query))
  }

  // Five rows by default; a search or "Show all" reaches the rest.
  const environments = () => {
    const list = filtered()
    return expanded() || search().trim() !== "" ? list : list.slice(0, 5)
  }

  const canExpand = () => search().trim() === "" && (data()?.environments.length ?? 0) > 5

  const envColor = (type: string) => {
    if (type === "production") return "#22c55e"
    if (type === "staging") return "#f59e0b"
    if (type === "development") return "#3b82f6"
    return "#6b7280"
  }

  const openRepos = (item: AdooItem) => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={`${ctx.t("repos")} · ${item.label}`}
        description={item.url}
        size="large"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <ReposList odoo={props.odoo} directory={props.directory} environment={item.id} />
      </ctx.ui.Dialog>
    ))
  }

  const openProgress = (item: AdooItem) => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={`${ctx.t("sync")} · ${item.label}`}
        description={item.url}
        size="large"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <SyncProgress odoo={props.odoo} />
      </ctx.ui.Dialog>
    ))
  }

  const sync = async (item: AdooItem) => {
    if (!item.stack) {
      ctx.toast.show({ title: ctx.t("adooNoStack") })
      return
    }
    setBusy(item.id)
    const result = await props.odoo
      .adooSync({ directory: props.directory, stack: item.stack, environment: item.id })
      .catch((error: unknown) => ({ started: false, message: String(error) }))
    setBusy(undefined)
    if (!result.started) {
      ctx.toast.show({ title: result.message || ctx.t("adooNothing"), variant: "error" })
      return
    }
    loadSync()
    openProgress(item)
  }

  const openRpc = async (item: AdooItem) => {
    const [list, detail] = await Promise.all([
      props.odoo.rpcList({}).catch(() => ({ path: "", connections: [] })),
      props.odoo.adooDatabase({ environment: item.id }).catch(() => ({ database: "" })),
    ])
    // adoo names every environment after its type ("Producción"), so the domain keeps connections apart.
    const name = item.url.replace(/^[a-z]+:\/\//i, "").replace(/[/?#].*$/, "") || item.label
    const saved =
      list.connections.find((connection) => connection.name === name) ??
      list.connections.find((connection) => connection.url === item.url)
    ctx.dialogs.open((dialog) => (
      <RpcDialog
        odoo={props.odoo}
        close={dialog.close}
        name={name}
        nameEditable={false}
        url={saved?.url ?? item.url}
        urlEditable={false}
        database={saved?.database ?? (detail.database || item.database || item.label)}
        databaseEditable
        username={saved?.username ?? ""}
        enabled={saved?.enabled ?? true}
        writes={saved?.writes ?? false}
        hasPassword={saved !== undefined}
        path={list.path}
      />
    ))
  }

  const openRebuildProgress = (item: AdooItem) => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={`${ctx.t("rebuild")} · ${item.label}`}
        description={item.url}
        size="normal"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <RebuildProgress odoo={props.odoo} />
      </ctx.ui.Dialog>
    ))
  }

  const startRebuild = async (item: AdooItem, filestore: boolean, repos: boolean, neutralize: boolean) => {
    setBusy(`${filestore ? "rebuild-f" : "rebuild"}:${item.id}`)
    const result = await props.odoo
      .adooRebuild({
        directory: props.directory,
        environment: item.id,
        stack: item.stack,
        name: item.label,
        filestore,
        repos,
        neutralize,
      })
      .catch((error: unknown) => ({ started: false, message: String(error) }))
    setBusy(undefined)
    if (!result.started) {
      ctx.toast.show({ title: result.message, variant: "error" })
      return
    }
    loadRebuild()
    openRebuildProgress(item)
  }

  const openRebuild = (item: AdooItem) => {
    if (rebuildStatus()?.running) {
      openRebuildProgress(item)
      return
    }
    const [syncRepos, setSyncRepos] = createSignal(true)
    const [neutralize, setNeutralize] = createSignal(true)
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={`${ctx.t("rebuild")} · ${item.label}`}
        description={item.url}
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <div class="flex flex-col gap-3">
          <ctx.ui.Switch
            label={ctx.t("rebuildSyncRepos")}
            description={ctx.t("rebuildSyncHint")}
            checked={syncRepos()}
            onChange={setSyncRepos}
          />
          <ctx.ui.Switch
            label={ctx.t("rebuildNeutralize")}
            description={ctx.t("rebuildNeutralizeHint")}
            checked={neutralize()}
            onChange={setNeutralize}
          />
          <div class="flex flex-col gap-2">
            <ctx.ui.Button
              size="small"
              variant="contrast"
              busy={busy() === `rebuild:${item.id}`}
              onClick={() => {
                dialog.close()
                void startRebuild(item, false, syncRepos(), neutralize())
              }}
            >
              {ctx.t("rebuildDb")}
            </ctx.ui.Button>
            <ctx.ui.Button
              size="small"
              busy={busy() === `rebuild-f:${item.id}`}
              onClick={() => {
                dialog.close()
                void startRebuild(item, true, syncRepos(), neutralize())
              }}
            >
              {ctx.t("rebuildWithFilestore")}
            </ctx.ui.Button>
          </div>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  let wasRunning = false
  createEffect(() => {
    const value = syncStatus()
    if (wasRunning && value && !value.running) {
      const failed = value.repos.filter((repo) => repo.state === "error").length
      ctx.toast.show({
        title: failed > 0 ? `${failed} ${ctx.t("syncFailed")}` : ctx.t("syncFinished"),
        variant: failed > 0 ? "error" : "success",
      })
    }
    wasRunning = value?.running ?? false
  })

  return (
    <Show when={status()} fallback={<span class="text-xs opacity-60 px-1">{ctx.t("loading")}</span>}>
      {(current) => (
        <Show
          when={current().state === "connected"}
          fallback={
            <div class="flex flex-col gap-2">
              <Show when={current().state === "pending"}>
                <span class="text-xs opacity-70 px-1">{ctx.t("adooPending")}</span>
                <div class="flex items-center gap-2 px-1">
                  <span class="text-sm font-semibold tracking-widest">{current().userCode}</span>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    icon="globe"
                    onClick={() => ctx.system.openExternal(current().verificationUri)}
                  >
                    {ctx.t("adooOpenPage")}
                  </ctx.ui.Button>
                </div>
              </Show>
              <Show when={current().state === "denied"}>
                <span class="text-xs opacity-70 px-1">{ctx.t("adooDenied")}</span>
              </Show>
              <Show when={current().state === "expired"}>
                <span class="text-xs opacity-70 px-1">{ctx.t("adooExpired")}</span>
              </Show>
              <Show when={current().state === "error"}>
                <span class="text-xs opacity-70 px-1">{current().message}</span>
              </Show>
              <ctx.ui.Button size="small" variant="contrast" busy={busy() === "connect"} onClick={() => void connect()}>
                {ctx.t("adooConnect")}
              </ctx.ui.Button>
            </div>
          }
        >
          <div class="flex items-center gap-1">
            <span class="text-xs flex-1 px-1 truncate">{current().name || current().email || current().role}</span>
            <ctx.ui.Button size="small" variant="ghost" busy={busy() === "logout"} onClick={() => void disconnect()}>
              {ctx.t("adooDisconnect")}
            </ctx.ui.Button>
          </div>
          <span class="text-[11px] opacity-50 px-1 truncate">
            {[current().email, current().role].filter(Boolean).join(" · ")}
          </span>
          <Show when={!current().scope.split(/\s+/).includes("database")}>
            <span class="text-[11px] opacity-70 px-1">{ctx.t("adooDatabase")}</span>
          </Show>
          <Show when={data()?.forbidden}>
            <span class="text-[11px] opacity-70 px-1">{ctx.t("adooForbidden")}</span>
          </Show>
          <Show when={data()} fallback={<span class="text-xs opacity-60 px-1">{ctx.t("loading")}</span>}>
            {(account) => (
              <div class="flex flex-col gap-2">
                <ctx.ui.TextInput
                  value={search()}
                  onInput={setSearch}
                  label={ctx.t("search")}
                  placeholder={ctx.t("search")}
                />
                <div class="flex items-center gap-1">
                  <span class="text-[11px] opacity-50 px-1 flex-1">
                    {`${ctx.t("adooEnvironments")} (${environments().length}/${account().environments.length})`}
                  </span>
                  <ctx.ui.IconButton
                    icon="outline-rotate-clockwise"
                    label={ctx.t("refresh")}
                    size="small"
                    onClick={loadData}
                  />
                </div>
                <For each={environments()}>
                  {(item) => {
                    const syncing = () => syncStatus()?.running === true && syncStatus()?.environment === item.id
                    const rebuilding = () =>
                      rebuildStatus()?.running === true && rebuildStatus()?.environment === item.id
                    return (
                      <div class="flex items-center gap-1 px-1 text-xs">
                        <span
                          class="inline-block w-2 h-2 rounded-full shrink-0"
                          style={{ "background-color": envColor(item.type) }}
                        />
                        <span
                          class="flex-1 truncate text-[11px] opacity-70"
                          title={`${item.label} · ${item.type || "?"}`}
                        >
                          {item.url || item.label}
                        </span>
                        <Show
                          when={syncing()}
                          fallback={
                            <>
                              <ctx.ui.IconButton
                                icon="lock"
                                label={ctx.t("rpc")}
                                size="small"
                                variant="ghost"
                                onClick={() => void openRpc(item)}
                              />
                              <ctx.ui.IconButton
                                icon="branch"
                                label={ctx.t("repos")}
                                size="small"
                                variant="ghost"
                                onClick={() => openRepos(item)}
                              />
                              <ctx.ui.Button
                                size="small"
                                variant="ghost"
                                busy={busy() === item.id}
                                onClick={() => void sync(item)}
                              >
                                {ctx.t("sync")}
                              </ctx.ui.Button>
                              <ctx.ui.Button
                                size="small"
                                variant="ghost"
                                busy={busy() === `rebuild:${item.id}` || busy() === `rebuild-f:${item.id}`}
                                onClick={() => openRebuild(item)}
                              >
                                {rebuilding() ? `${rebuildPercent(rebuildStatus())}%` : ctx.t("rebuild")}
                              </ctx.ui.Button>
                            </>
                          }
                        >
                          <ctx.ui.IconButton
                            icon="lock"
                            label={ctx.t("rpc")}
                            size="small"
                            variant="ghost"
                            onClick={() => void openRpc(item)}
                          />
                          <ctx.ui.IconButton
                            icon="branch"
                            label={ctx.t("repos")}
                            size="small"
                            variant="ghost"
                            onClick={() => openRepos(item)}
                          />
                          <span class="text-[11px] opacity-60">
                            {`${syncStatus()?.done ?? 0}/${syncStatus()?.total ?? 0}`}
                          </span>
                          <ctx.ui.Button size="small" variant="ghost" onClick={() => openProgress(item)}>
                            {ctx.t("progress")}
                          </ctx.ui.Button>
                        </Show>
                      </div>
                    )
                  }}
                </For>
                <Show when={canExpand()}>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    class="justify-start"
                    onClick={() => setExpanded(!expanded())}
                  >
                    {expanded() ? ctx.t("showLess") : `${ctx.t("showAll")} (${account().environments.length})`}
                  </ctx.ui.Button>
                </Show>
              </div>
            )}
          </Show>
        </Show>
      )}
    </Show>
  )
}

function SyncProgress(props: { odoo: OdooClient }) {
  const [status, setStatus] = createSignal<AdooSyncStatus | undefined>()
  const ctx = usePlugin()

  const load = () =>
    void props.odoo
      .adooSyncStatus({})
      .then(setStatus)
      .catch(() => undefined)

  onMount(load)
  createKeyed(
    () => status()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(load, 500)
      onCleanup(() => clearInterval(timer))
    },
  )

  const percent = () => {
    const value = status()
    if (!value || value.total === 0) return 0
    return Math.round((value.done / value.total) * 100)
  }

  const stateLabel = (state: string) => {
    if (state === "pending") return ctx.t("syncPending")
    if (state === "clone") return ctx.t("syncCloning")
    if (state === "pull") return ctx.t("syncPulling")
    if (state === "done") return ctx.t("syncDone")
    if (state === "skipped") return ctx.t("syncSkipped")
    return ctx.t("syncFailed")
  }

  const stateColor = (state: string) => {
    if (state === "error") return "#ef4444"
    if (state === "done") return "#22c55e"
    if (state === "skipped") return "#6b7280"
    return "#f59e0b"
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="flex-1">{`${status()?.done ?? 0} / ${status()?.total ?? 0}`}</span>
        <span class="opacity-60">{`${percent()}%`}</span>
      </div>
      <div class="h-2 w-full rounded-full overflow-hidden" style={{ "background-color": "rgba(128,128,128,0.25)" }}>
        <div class="h-full transition-all" style={{ width: `${percent()}%`, "background-color": "#22c55e" }} />
      </div>
      <div class="flex flex-col gap-1 max-h-[50vh] overflow-y-auto">
        <For each={status()?.repos ?? []}>
          {(repo) => (
            <div class="flex flex-col gap-0.5 px-1">
              <div class="flex items-center gap-2 text-xs">
                <span
                  class="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ "background-color": stateColor(repo.state) }}
                />
                <span class="flex-1 truncate" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                  {repo.path}
                </span>
                <span class="text-[11px] opacity-60">{stateLabel(repo.state)}</span>
              </div>
              <Show when={repo.message}>
                <span class="text-[11px] opacity-50 pl-4 truncate">{repo.message}</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function ReposList(props: { odoo: OdooClient; directory: string; environment: string }) {
  const ctx = usePlugin()
  const [result, setResult] = createSignal<Awaited<ReturnType<OdooClient["adooRepos"]>>>()
  const [loading, setLoading] = createSignal(false)

  const openChanges = (repo: { path: string }) => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("changes")}
        description={repo.path}
        size="large"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <RepoChangesView odoo={props.odoo} directory={props.directory} repository={repo.path} />
      </ctx.ui.Dialog>
    ))
  }

  const load = async () => {
    setLoading(true)
    const next = await props.odoo
      .adooRepos({ directory: props.directory, environment: props.environment })
      .catch((error: unknown) => ({ message: String(error), venv: "", repos: [] }))
    setResult(next)
    setLoading(false)
  }

  onMount(() => void load())

  const ledColor = (state: string) => {
    if (state === "same") return "#22c55e"
    if (state === "different") return "#f59e0b"
    if (state === "missing") return "#6b7280"
    if (state === "unknown") return "#3b82f6"
    return "#ef4444"
  }

  const stateLabel = (state: string) => {
    if (state === "same") return ctx.t("repoSame")
    if (state === "different") return ctx.t("repoDifferent")
    if (state === "missing") return ctx.t("repoMissing")
    if (state === "unknown") return ctx.t("repoUnknown")
    return ctx.t("repoError")
  }

  const short = (hash: string) => (hash === "" ? "—" : hash.slice(0, 7))

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <span class="text-[11px] opacity-50 flex-1 truncate">
          {result()?.venv ? `${ctx.t("venv")}: ${result()?.venv}` : (result()?.message ?? "")}
        </span>
        <ctx.ui.IconButton
          icon="outline-rotate-clockwise"
          label={ctx.t("refresh")}
          size="small"
          busy={loading()}
          onClick={() => void load()}
        />
      </div>
      <div class="flex flex-col gap-1 max-h-[50vh] overflow-y-auto">
        <For each={result()?.repos ?? []}>
          {(repo) => (
            <div class="flex flex-col gap-0.5 px-1">
              <div class="flex items-center gap-2 text-xs">
                <span
                  class="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ "background-color": ledColor(repo.state) }}
                />
                <span class="flex-1 truncate" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                  {repo.path}
                </span>
                <span class="text-[11px] opacity-60">{stateLabel(repo.state)}</span>
                <ctx.ui.IconButton
                  icon="edit"
                  label={ctx.t("changes")}
                  size="small"
                  variant="ghost"
                  onClick={() => openChanges(repo)}
                />
              </div>
              <span class="text-[11px] opacity-50 pl-4 truncate">
                {`${ctx.t("local")} ${short(repo.local)} · ${ctx.t("adoo")} ${short(repo.commit)}`}
              </span>
              <Show when={repo.localBranch}>
                <span class="text-[11px] pl-4 truncate" style={{ color: repo.changed > 0 ? "#f59e0b" : undefined }}>
                  {`${repo.localBranch} · ${repo.changed} ${ctx.t("changedFiles")}`}
                </span>
              </Show>
              <Show when={repo.requirements > 0}>
                <span
                  class="text-[11px] pl-4 truncate"
                  style={{ color: repo.missing.length > 0 ? "#f59e0b" : "#22c55e" }}
                >
                  <Show
                    when={repo.missing.length > 0}
                    fallback={`${repo.requirements}/${repo.requirements} ${ctx.t("depsInstalled")}`}
                  >
                    {`${repo.requirements - repo.missing.length}/${repo.requirements} ${ctx.t("depsInstalled")} · ${ctx.t("depsMissing")}: ${repo.missing.slice(0, 4).join(", ")}${repo.missing.length > 4 ? "…" : ""}`}
                  </Show>
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  )
}

function InstallProgress(props: { odoo: OdooClient }) {
  const ctx = usePlugin()
  const [status, setStatus] = createSignal<InstallStatus | undefined>()

  const load = () =>
    void props.odoo
      .installStatus({})
      .then(setStatus)
      .catch(() => undefined)

  onMount(load)
  createKeyed(
    () => status()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(load, 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  const stepLabel = (step: string) => {
    if (step === "clone") return ctx.t("installCloning")
    if (step === "venv") return ctx.t("installVenv")
    if (step === "requirements") return ctx.t("installRequirements")
    if (step === "done") return ctx.t("installDone")
    if (step === "error") return ctx.t("installFailed")
    return ctx.t("loading")
  }

  const elapsed = () => {
    const value = status()
    if (!value?.startedAt) return 0
    return Math.max(0, Math.round((Date.now() - value.startedAt) / 1000))
  }

  const progress = () => {
    const step = status()?.step
    if (step === "done" || step === "error") return 100
    if (step === "clone") return 25
    if (step === "venv") return 50
    if (step === "requirements") return 75
    return 5
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="flex-1 truncate">{`${status()?.version ?? ""} · ${stepLabel(status()?.step ?? "")}`}</span>
        <span class="opacity-60">{`${elapsed()}s`}</span>
      </div>
      <div class="h-2 w-full rounded-full overflow-hidden" style={{ "background-color": "rgba(128,128,128,0.25)" }}>
        <div
          class="h-full transition-all"
          style={{
            width: `${progress()}%`,
            "background-color": status()?.step === "error" ? "#ef4444" : "#22c55e",
          }}
        />
      </div>
      <Show when={status()?.message}>
        <span class="text-[11px] opacity-70 whitespace-pre-wrap break-words">{status()?.message}</span>
      </Show>
    </div>
  )
}

function PythonPackages(props: { odoo: OdooClient; directory: string; version: string }) {
  const ctx = usePlugin()
  const [packages, setPackages] = createSignal("")
  const [status, setStatus] = createSignal<PythonStatus | undefined>()

  const load = () =>
    void props.odoo
      .pythonInstallStatus({})
      .then(setStatus)
      .catch(() => undefined)

  onMount(load)
  createKeyed(
    () => status()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(load, 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  let wasRunning = false
  createEffect(() => {
    const value = status()
    if (wasRunning && value && !value.running) {
      ctx.toast.show({
        title: value.message,
        variant: value.message.startsWith("Installed") ? "success" : "error",
      })
    }
    wasRunning = value?.running ?? false
  })

  const elapsed = () => {
    const value = status()
    if (!value?.startedAt) return 0
    return Math.max(0, Math.round((Date.now() - value.startedAt) / 1000))
  }

  const install = async () => {
    const value = packages().trim()
    if (value === "") return
    const result = await props.odoo
      .pythonInstall({ directory: props.directory, version: props.version, packages: value })
      .catch((error: unknown) => ({ started: false, message: String(error) }))
    if (!result.started) {
      ctx.toast.show({ title: result.message, variant: "error" })
      return
    }
    setPackages("")
    load()
  }

  return (
    <div class="flex flex-col gap-2">
      <span class="text-[11px] opacity-50 px-1">{`bin/${props.version}/.venv · ${ctx.t("pythonHint")}`}</span>
      <div class="flex items-center gap-1">
        <ctx.ui.TextInput
          value={packages()}
          onInput={setPackages}
          onSubmit={() => void install()}
          label={ctx.t("pythonPackages")}
          placeholder="pandas openpyxl"
          class="flex-1"
        />
        <ctx.ui.Button
          size="small"
          variant="contrast"
          busy={status()?.running === true}
          disabled={packages().trim() === ""}
          onClick={() => void install()}
        >
          {ctx.t("add")}
        </ctx.ui.Button>
      </div>
      <Show when={status()?.running}>
        <span class="text-xs opacity-70 px-1 truncate">{`${status()?.packages ?? ""} · ${elapsed()}s`}</span>
      </Show>
      <Show when={status()?.running !== true && status()?.message}>
        <span class="text-[11px] opacity-60 px-1 truncate">{status()?.message}</span>
      </Show>
    </div>
  )
}

function AddonsPaths(props: { odoo: OdooClient; directory: string; label: string; root: string }) {
  const ctx = usePlugin()
  const [state, setState] = createSignal<AddonsState | undefined>()
  const [busyPath, setBusyPath] = createSignal<string | undefined>()
  const [pythonStatus, setPythonStatus] = createSignal<PythonStatus | undefined>()

  const load = () =>
    void props.odoo
      .addons({ directory: props.directory, label: props.label })
      .then(setState)
      .catch(() => setState({ active: [], available: [] }))

  const loadPython = () =>
    void props.odoo
      .pythonInstallStatus({})
      .then(setPythonStatus)
      .catch(() => undefined)

  createKeyed(
    () => `${props.directory}:${props.label}`,
    () => load(),
  )
  onMount(loadPython)
  createKeyed(
    () => pythonStatus()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(loadPython, 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  let wasRunning = false
  createEffect(() => {
    const value = pythonStatus()
    if (wasRunning && value && !value.running) {
      setBusyPath(undefined)
      ctx.toast.show({
        title: value.message,
        variant: value.message.startsWith("Installed") ? "success" : "error",
      })
      void load()
    }
    wasRunning = value?.running ?? false
  })

  const toggle = async (path: string, enabled: boolean) => {
    setBusyPath(path)
    const next = await props.odoo
      .addonsToggle({ directory: props.directory, label: props.label, path, enabled })
      .catch(() => undefined)
    setBusyPath(undefined)
    if (next) setState(next)
  }

  const installDeps = async (path: string) => {
    setBusyPath(path)
    const result = await props.odoo
      .addonsDeps({ directory: props.directory, label: props.label, path })
      .catch((error: unknown) => ({ started: false, message: String(error) }))
    if (!result.started) {
      setBusyPath(undefined)
      ctx.toast.show({ title: result.message, variant: "error" })
      return
    }
    loadPython()
  }

  const short = (path: string) => (path.startsWith(`${props.root}/`) ? path.slice(props.root.length + 1) : path)

  const openGit = (repository: string) =>
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("changes")}
        description={props.directory}
        size="large"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <RepoChangesView odoo={props.odoo} directory={props.directory} repository={repository} />
      </ctx.ui.Dialog>
    ))

  const deps = (item: AddonsState["active"][number]) => (
    <Show when={item.requirements > 0}>
      <Show
        when={item.missing.length === 0}
        fallback={
          <span class="flex items-center gap-1">
            <span
              title={`${ctx.t("depsMissing")}: ${item.missing.slice(0, 6).join(", ")}`}
              style={{ color: "#f59e0b" }}
            >
              <ctx.ui.Icon name="circle-exclamation" size="small" />
            </span>
            <ctx.ui.IconButton
              icon="download"
              label={ctx.t("installDeps")}
              size="small"
              variant="ghost"
              busy={busyPath() === item.path}
              onClick={() => void installDeps(item.path)}
            />
          </span>
        }
      >
        <span title={ctx.t("depsOk")} style={{ color: "#22c55e" }}>
          <ctx.ui.Icon name="circle-check" size="small" />
        </span>
      </Show>
    </Show>
  )

  return (
    <div class="flex flex-col gap-1">
      <span class="text-[11px] opacity-50 px-1">{ctx.t("addonsActive")}</span>
      <Show
        when={(state()?.active ?? []).length > 0}
        fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("addonsNone")}</span>}
      >
        <For each={state()?.active ?? []}>
          {(item) => (
            <div class="flex items-center gap-1 px-1 text-xs">
              <span
                class="flex-1 truncate"
                style={{ "font-family": "var(--font-family-mono, monospace)" }}
                title={item.path}
              >
                {short(item.path)}
              </span>
              {deps(item)}
              <ctx.ui.IconButton
                icon="branch"
                label={ctx.t("changes")}
                size="small"
                variant="ghost"
                onClick={() => openGit(short(item.path))}
              />
              <ctx.ui.IconButton
                icon="minus"
                label={ctx.t("deactivate")}
                size="small"
                variant="ghost"
                busy={busyPath() === item.path}
                onClick={() => void toggle(item.path, false)}
              />
            </div>
          )}
        </For>
      </Show>

      <span class="text-[11px] opacity-50 px-1 pt-2">{ctx.t("addonsAvailable")}</span>
      <Show
        when={(state()?.available ?? []).length > 0}
        fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("addonsNone")}</span>}
      >
        <For each={state()?.available ?? []}>
          {(item) => (
            <div class="flex items-center gap-1 px-1 text-xs">
              <span
                class="flex-1 truncate opacity-60"
                style={{ "font-family": "var(--font-family-mono, monospace)" }}
                title={item.path}
              >
                {short(item.path)}
              </span>
              <Show when={!item.exists}>
                <span class="text-[11px]" style={{ color: "#f59e0b" }}>
                  {ctx.t("missingFolder")}
                </span>
              </Show>
              {deps(item)}
              <ctx.ui.IconButton
                icon="plus"
                label={ctx.t("activate")}
                size="small"
                variant="ghost"
                disabled={!item.exists}
                busy={busyPath() === item.path}
                onClick={() => void toggle(item.path, true)}
              />
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function rebuildPercent(status: RebuildStatus | undefined): number {
  if (!status) return 0
  if (status.step === "download" && status.totalBytes > 0) {
    return Math.min(100, Math.round((status.bytes / status.totalBytes) * 100))
  }
  const step = status.step
  if (step === "done" || step === "error") return 100
  if (step === "generate") return 10
  if (step === "wait") return 25
  if (step === "download") return 45
  if (step === "create") return 60
  if (step === "restore") return 80
  if (step === "filestore") return 90
  if (step === "neutralize") return 92
  if (step === "repos") return 95
  return 5
}

function RebuildProgress(props: { odoo: OdooClient }) {
  const ctx = usePlugin()
  const [status, setStatus] = createSignal<RebuildStatus | undefined>()

  const load = () =>
    void props.odoo
      .adooRebuildStatus({})
      .then(setStatus)
      .catch(() => undefined)

  onMount(load)
  createKeyed(
    () => status()?.running,
    (running) => {
      if (!running) return
      const timer = setInterval(load, 1000)
      onCleanup(() => clearInterval(timer))
    },
  )

  const [speed, setSpeed] = createSignal(0)
  let last = { bytes: 0, at: 0 }
  createEffect(() => {
    const value = status()
    if (!value) return
    const now = Date.now()
    if (last.at > 0 && value.bytes >= last.bytes) {
      const seconds = (now - last.at) / 1000
      if (seconds > 0) setSpeed((value.bytes - last.bytes) / seconds)
    }
    last = { bytes: value.bytes, at: now }
  })

  const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`

  const eta = () => {
    const value = status()
    if (!value?.totalBytes || speed() <= 0) return 0
    return Math.max(0, (value.totalBytes - value.bytes) / speed())
  }

  const stepLabel = (step: string) => {
    if (step === "generate") return ctx.t("rebuildGenerate")
    if (step === "wait") return ctx.t("rebuildWait")
    if (step === "download") return ctx.t("rebuildDownload")
    if (step === "create") return ctx.t("rebuildCreate")
    if (step === "restore") return ctx.t("rebuildRestore")
    if (step === "filestore") return ctx.t("rebuildFilestore")
    if (step === "neutralize") return ctx.t("rebuildNeutralizeStep")
    if (step === "repos") return ctx.t("rebuildRepos")
    if (step === "done") return ctx.t("rebuildDone")
    if (step === "error") return ctx.t("rebuildFailed")
    return ctx.t("loading")
  }

  const progress = () => rebuildPercent(status())

  const elapsed = () => {
    const value = status()
    if (!value?.startedAt) return 0
    return Math.max(0, Math.round((Date.now() - value.startedAt) / 1000))
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-2 text-xs">
        <span class="flex-1 truncate">{stepLabel(status()?.step ?? "")}</span>
        <span class="opacity-60">{`${elapsed()}s`}</span>
      </div>
      <div class="h-2 w-full rounded-full overflow-hidden" style={{ "background-color": "rgba(128,128,128,0.25)" }}>
        <div
          class="h-full transition-all"
          style={{
            width: `${progress()}%`,
            "background-color": status()?.step === "error" ? "#ef4444" : "#22c55e",
          }}
        />
      </div>
      <Show when={status()?.step === "download" || (status()?.bytes ?? 0) > 0}>
        <div class="flex items-center gap-2 text-[11px] opacity-70">
          <span class="flex-1 truncate">
            {`${megabytes(status()?.bytes ?? 0)}${(status()?.totalBytes ?? 0) > 0 ? ` / ${megabytes(status()?.totalBytes ?? 0)}` : ""}`}
          </span>
          <span>{`${(speed() / (1024 * 1024)).toFixed(1)} MB/s`}</span>
          <Show when={eta() > 0}>
            <span>{`${Math.ceil(eta())}s`}</span>
          </Show>
        </div>
      </Show>
      <Show when={status()?.database}>
        <span class="text-[11px] opacity-60">{`${ctx.t("database")}: ${status()?.database}`}</span>
      </Show>
      <Show when={status()?.message}>
        <span class="text-[11px] opacity-70 whitespace-pre-wrap break-words">{status()?.message}</span>
      </Show>
    </div>
  )
}

function RepoChangesView(props: { odoo: OdooClient; directory: string; repository: string }) {
  const ctx = usePlugin()
  const [data, setData] = createSignal<RepoChanges | undefined>()

  const load = () =>
    void props.odoo
      .repoChanges({ directory: props.directory, repository: props.repository })
      .then(setData)
      .catch(() => setData({ branch: "", files: [], diff: "" }))

  onMount(load)

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2 text-[11px] opacity-60">
        <span class="flex-1 truncate">{`${props.repository} · ${data()?.branch ?? ""}`}</span>
        <ctx.ui.IconButton icon="outline-rotate-clockwise" label={ctx.t("refresh")} size="small" onClick={load} />
      </div>
      <div class="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
        <For each={data()?.files ?? []}>
          {(file) => (
            <span class="text-[11px] truncate">
              <span class="inline-block w-6 opacity-50">{file.code}</span>
              {file.path}
            </span>
          )}
        </For>
      </div>
      <pre
        class="text-[11px] whitespace-pre-wrap overflow-auto max-h-[45vh] p-2"
        style={{ "font-family": "var(--font-family-mono, monospace)" }}
      >
        {data()?.diff || ctx.t("noChanges")}
      </pre>
    </div>
  )
}

function RpcDialog(props: {
  odoo: OdooClient
  close: () => void
  name: string
  nameEditable: boolean
  url: string
  urlEditable: boolean
  database: string
  databaseEditable: boolean
  username: string
  enabled: boolean
  writes: boolean
  hasPassword: boolean
  path: string
  onSaved?: () => void
}) {
  const ctx = usePlugin()
  const [name, setName] = createSignal(props.name)
  const [url, setUrl] = createSignal(props.url)
  const [database, setDatabase] = createSignal(props.database)
  const [username, setUsername] = createSignal(props.username)
  const [password, setPassword] = createSignal("")
  const [enabled, setEnabled] = createSignal(props.enabled)
  const [writes, setWrites] = createSignal(props.writes)
  const [saving, setSaving] = createSignal(false)

  const save = async () => {
    const target = name().trim()
    if (target === "") {
      ctx.toast.show({ title: ctx.t("rpcNameRequired"), variant: "error" })
      return
    }
    setSaving(true)
    const result = await props.odoo
      .rpcSave({
        name: target,
        url: url(),
        database: database(),
        username: username(),
        password: password(),
        enabled: enabled(),
        writes: writes(),
      })
      .catch((error: unknown) => {
        ctx.toast.show({ title: String(error), variant: "error" })
        return undefined
      })
    setSaving(false)
    if (!result) return
    ctx.toast.show({ title: ctx.t("rpcSaved"), variant: "success" })
    props.close()
    props.onSaved?.()
  }

  return (
    <ctx.ui.Dialog
      title={props.nameEditable ? ctx.t("rpc") : `${ctx.t("rpc")} · ${props.name}`}
      description={props.path}
      footer={
        <>
          <ctx.ui.Button variant="ghost" onClick={props.close}>
            {ctx.t("cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button variant="contrast" busy={saving()} onClick={() => void save()}>
            {ctx.t("save")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <Show when={props.nameEditable}>
          <div class="flex items-center gap-1">
            <span class="text-xs opacity-60 w-24 shrink-0">{ctx.t("rpcName")}</span>
            <ctx.ui.TextInput
              value={name()}
              onInput={setName}
              label={ctx.t("rpcName")}
              placeholder="prod"
              class="flex-1"
            />
          </div>
        </Show>
        <div class="flex items-center gap-1">
          <span class="text-xs opacity-60 w-24 shrink-0">{ctx.t("rpcUrl")}</span>
          <Show when={props.urlEditable} fallback={<span class="flex-1 text-[11px] opacity-60 truncate">{url()}</span>}>
            <ctx.ui.TextInput
              value={url()}
              onInput={setUrl}
              label={ctx.t("rpcUrl")}
              placeholder="https://odoo.example.com"
              class="flex-1"
            />
          </Show>
        </div>
        <div class="flex items-center gap-1">
          <span class="text-xs opacity-60 w-24 shrink-0">{ctx.t("rpcDatabase")}</span>
          <Show
            when={props.databaseEditable}
            fallback={<span class="flex-1 text-[11px] opacity-60 truncate">{database()}</span>}
          >
            <ctx.ui.TextInput value={database()} onInput={setDatabase} label={ctx.t("rpcDatabase")} class="flex-1" />
          </Show>
        </div>
        <div class="flex items-center gap-1">
          <span class="text-xs opacity-60 w-24 shrink-0">{ctx.t("rpcUsername")}</span>
          <ctx.ui.TextInput value={username()} onInput={setUsername} label={ctx.t("rpcUsername")} class="flex-1" />
        </div>
        <div class="flex items-center gap-1">
          <span class="text-xs opacity-60 w-24 shrink-0">{ctx.t("rpcPassword")}</span>
          <ctx.ui.TextInput
            type="password"
            value={password()}
            onInput={setPassword}
            label={ctx.t("rpcPassword")}
            placeholder={props.hasPassword ? ctx.t("rpcPasswordSaved") : "API key"}
            class="flex-1"
          />
        </div>
        <ctx.ui.Switch
          label={ctx.t("rpcEnabled")}
          description={ctx.t("rpcEnabledHint")}
          checked={enabled()}
          onChange={setEnabled}
        />
        <ctx.ui.Switch
          label={ctx.t("rpcWrites")}
          description={ctx.t("rpcWritesHint")}
          checked={writes()}
          onChange={setWrites}
          disabled={!enabled()}
        />
      </div>
    </ctx.ui.Dialog>
  )
}

function RpcConnections(props: { odoo: OdooClient }) {
  const ctx = usePlugin()
  const [data, setData] = createSignal<Awaited<ReturnType<OdooClient["rpcList"]>> | undefined>()

  const load = () =>
    void props.odoo
      .rpcList({})
      .then(setData)
      .catch(() => setData(undefined))

  onMount(load)

  const add = () =>
    ctx.dialogs.open((dialog) => (
      <RpcDialog
        odoo={props.odoo}
        close={dialog.close}
        name=""
        nameEditable
        url=""
        urlEditable
        database=""
        databaseEditable
        username=""
        enabled
        writes={false}
        hasPassword={false}
        path={data()?.path ?? ""}
        onSaved={load}
      />
    ))

  const edit = (connection: {
    name: string
    url: string
    database: string
    username: string
    enabled: boolean
    writes: boolean
  }) =>
    ctx.dialogs.open((dialog) => (
      <RpcDialog
        odoo={props.odoo}
        close={dialog.close}
        name={connection.name}
        nameEditable={false}
        url={connection.url}
        urlEditable
        database={connection.database}
        databaseEditable
        username={connection.username}
        enabled={connection.enabled}
        writes={connection.writes}
        hasPassword
        path={data()?.path ?? ""}
        onSaved={load}
      />
    ))

  const remove = async (name: string) => {
    const message = await props.odoo.rpcRemove({ name }).catch((error: unknown) => String(error))
    ctx.toast.show({ title: message, variant: "success" })
    load()
  }

  return (
    <div class="flex flex-col gap-1">
      <div class="flex items-center gap-1">
        <span class="text-[11px] opacity-50 px-1 flex-1 truncate">{data()?.path ?? ""}</span>
        <ctx.ui.Button size="small" variant="ghost" icon="plus" onClick={add}>
          {ctx.t("add")}
        </ctx.ui.Button>
      </div>
      <Show
        when={(data()?.connections ?? []).length > 0}
        fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("rpcNone")}</span>}
      >
        <For each={data()?.connections ?? []}>
          {(connection) => (
            <div class="flex items-center gap-1 px-1 text-xs">
              <span class="w-24 shrink-0 truncate">{connection.name}</span>
              <span class="flex-1 truncate opacity-60" title={connection.url}>
                {`${connection.url} · ${connection.database} · ${connection.username}`}
              </span>
              <span class="text-[11px]" style={{ color: connection.enabled ? "#22c55e" : "#6b7280" }}>
                {connection.enabled ? ctx.t("rpcOn") : ctx.t("rpcOff")}
              </span>
              <span class="text-[11px]" style={{ color: connection.writes ? "#f59e0b" : "#6b7280" }}>
                {connection.writes ? ctx.t("rpcWritesOn") : ctx.t("rpcReadOnly")}
              </span>
              <ctx.ui.IconButton
                icon="edit"
                label={ctx.t("edit")}
                size="small"
                variant="ghost"
                onClick={() => edit(connection)}
              />
              <ctx.ui.IconButton
                icon="trash"
                label={ctx.t("delete")}
                size="small"
                variant="ghost"
                onClick={() => void remove(connection.name)}
              />
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function CliDialog(props: { odoo: OdooClient; directory: string; close: () => void }) {
  const ctx = usePlugin()
  const [data, setData] = createSignal<Awaited<ReturnType<OdooClient["odooCli"]>> | undefined>()
  const [busy, setBusy] = createSignal(false)

  const load = () =>
    void props.odoo
      .odooCli({ directory: props.directory })
      .then(setData)
      .catch(() => setData(undefined))

  onMount(load)

  const install = async () => {
    setBusy(true)
    const message = await props.odoo
      .odooCliInstall({ directory: props.directory })
      .catch((error: unknown) => String(error))
    setBusy(false)
    ctx.toast.show({ title: message })
    load()
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("cliTitle")}
      description={props.directory}
      size="large"
      footer={
        <ctx.ui.Button variant="contrast" onClick={props.close}>
          {ctx.t("close")}
        </ctx.ui.Button>
      }
    >
      <Show when={data()} fallback={<span class="text-xs opacity-50">{ctx.t("loading")}</span>}>
        {(value) => (
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-0.5">
              <span class="text-[11px] opacity-50">{ctx.t("cliLauncher")}</span>
              <span class="text-[11px] break-all" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                {value().launcher}
              </span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="text-[11px] opacity-50">{ctx.t("cliPath")}</span>
              <span class="text-[11px] break-all" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                {`${value().target} → ${
                  value().installed
                    ? ctx.t("cliInstalledShort")
                    : value().current === ""
                      ? ctx.t("cliNotInstalled")
                      : value().current
                }`}
              </span>
            </div>
            <span class="text-[11px] opacity-60">{ctx.t("cliHint")}</span>
            <Show when={!value().installed}>
              <span class="text-[11px] opacity-60">{ctx.t("cliReplaceHint")}</span>
              <div>
                <ctx.ui.Button size="small" variant="contrast" busy={busy()} onClick={() => void install()}>
                  {ctx.t("cliInstall")}
                </ctx.ui.Button>
              </div>
            </Show>
          </div>
        )}
      </Show>
    </ctx.ui.Dialog>
  )
}
