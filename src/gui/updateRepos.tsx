import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { OdooClient } from "./contract"

const GREEN = "#22c55e"
const AMBER = "#f59e0b"
const RED = "#ef4444"
const GRAY = "#9ca3af"

type State = "current" | "behind" | "diverged" | "skipped" | "error"

interface Status {
  path: string
  branch: string
  state: State
  ahead: number
  behind: number
  message: string
}

export function UpdateReposDialog(props: {
  odoo: OdooClient
  directory: string
  close: () => void
  onDone: () => void
}) {
  const ctx = usePlugin()
  const [hard, setHard] = createSignal(false)
  const [scanning, setScanning] = createSignal(false)
  const [updating, setUpdating] = createSignal("")
  const [statuses, setStatuses] = createSignal<Status[]>([])
  const [logText, setLogText] = createSignal("")
  let logPre: HTMLPreElement | undefined

  const loadLog = () =>
    void props.odoo
      .reposUpdateLog({ directory: props.directory })
      .then((result) => {
        setLogText(result.text)
        queueMicrotask(() => {
          if (logPre) logPre.scrollTop = logPre.scrollHeight
        })
      })
      .catch(() => undefined)

  const scan = async () => {
    setScanning(true)
    const result = await props.odoo
      .reposStatus({ directory: props.directory })
      .catch(() => ({ repos: [] as Status[] }))
    setScanning(false)
    setStatuses([...result.repos])
  }

  onMount(() => {
    void scan()
    loadLog()
    const timer = setInterval(loadLog, 1500)
    onCleanup(() => clearInterval(timer))
  })

  const pending = () => statuses().filter((status) => status.state !== "current")
  const current = () => statuses().filter((status) => status.state === "current").length

  const update = async (paths: string[]) => {
    if (updating() !== "" || paths.length === 0) return
    setUpdating(paths.length === 1 ? (paths[0] ?? "all") : "all")
    const outcome = await props.odoo
      .reposUpdate({ directory: props.directory, hard: hard(), paths })
      .catch(() => ({ results: [], updated: 0, failed: 1 }))
    setUpdating("")
    const failed = outcome.results.find((result) => result.state === "error")
    if (failed) {
      ctx.toast.show({ title: failed.message || ctx.t("repoUpdateFailed"), variant: "error" })
    } else {
      ctx.toast.show({
        title:
          outcome.updated > 0
            ? `${outcome.updated} ${ctx.t("repoUpdateUpdated")}`
            : ctx.t("repoUpdateCurrent"),
        variant: "success",
      })
    }
    props.onDone()
    loadLog()
    await scan()
  }

  const label = (status: Status) => {
    if (status.state === "behind") return `${ctx.t("repoUpdateBehind")} ↓${status.behind}`
    if (status.state === "diverged") return `↑${status.ahead} ↓${status.behind}`
    if (status.state === "skipped") return ctx.t("repoUpdateSkipped")
    if (status.state === "error") return ctx.t("repoUpdateFailed")
    return ctx.t("repoUpdateCurrent")
  }
  const color = (status: Status) => {
    if (status.state === "behind") return AMBER
    if (status.state === "diverged" || status.state === "error") return RED
    if (status.state === "skipped") return GRAY
    return GREEN
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("reposUpdate")}
      description={ctx.t("reposUpdateHint")}
      size="large"
      footer={
        <>
          <ctx.ui.Button variant="ghost" onClick={props.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
          <ctx.ui.Button
            variant="contrast"
            busy={updating() === "all"}
            disabled={pending().length === 0 || updating() !== "" || scanning()}
            onClick={() => void update(pending().map((status) => status.path))}
          >
            {`${ctx.t("reposUpdateAll")} (${pending().length})`}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <ctx.ui.Switch
          label={ctx.t("reposUpdateHard")}
          description={ctx.t("reposUpdateHardHint")}
          checked={hard()}
          onChange={setHard}
        />
        <div class="flex items-center gap-1">
          <span class="flex-1 text-[11px] opacity-50 px-1">
            {scanning()
              ? ctx.t("repoUpdateChecking")
              : `${pending().length} ${ctx.t("repoUpdateOutdated")} · ${current()} ${ctx.t("repoUpdateUpToDate")}`}
          </span>
          <ctx.ui.Tooltip value={ctx.t("refresh")}>
            <ctx.ui.IconButton
              icon="outline-rotate-clockwise"
              label={ctx.t("refresh")}
              size="small"
              variant="ghost"
              busy={scanning()}
              onClick={() => void scan()}
            />
          </ctx.ui.Tooltip>
        </div>
        <Show
          when={pending().length > 0}
          fallback={
            <div class="flex flex-col items-center gap-2 py-5 text-center">
              <ctx.ui.Icon name="circle-check" size="large" />
              <span class="text-xs opacity-60">{ctx.t("repoUpdateAllCurrent")}</span>
            </div>
          }
        >
          <div class="flex flex-col gap-0.5 max-h-72 overflow-y-auto">
            <For each={pending()}>
              {(status) => (
                <div class="flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-v2-background-bg-layer-02">
                  <span
                    class="flex-1 truncate"
                    style={{ "font-family": "var(--font-family-mono, monospace)" }}
                    title={`${status.path} · ${status.message}`}
                  >
                    {status.path}
                  </span>
                  <span class="shrink-0 text-[11px] opacity-40">{status.branch}</span>
                  <span class="shrink-0 text-[11px]" style={{ color: color(status) }}>
                    {label(status)}
                  </span>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    icon="arrow-down-to-line"
                    busy={updating() === status.path}
                    disabled={updating() !== ""}
                    onClick={() => void update([status.path])}
                  >
                    {ctx.t("repoUpdateOne")}
                  </ctx.ui.Button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={logText() !== ""}>
          <div class="flex flex-col gap-1">
            <span class="text-[11px] opacity-50 px-1">{ctx.t("repoUpdateLog")}</span>
            <pre
              ref={logPre}
              class="text-[11px] whitespace-pre-wrap max-h-40 overflow-auto p-2"
              style={{ "font-family": "var(--font-family-mono, monospace)" }}
            >
              {logText()}
            </pre>
          </div>
        </Show>
      </div>
    </ctx.ui.Dialog>
  )
}
