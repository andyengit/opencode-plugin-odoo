import { createSignal, For, Show } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { OdooClient } from "./contract"

const GREEN = "#22c55e"
const AMBER = "#f59e0b"
const RED = "#ef4444"
const GRAY = "#9ca3af"

type State = "updated" | "current" | "skipped" | "error"

interface Result {
  path: string
  branch: string
  state: State
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
  const [busy, setBusy] = createSignal(false)
  const [ran, setRan] = createSignal(false)
  const [results, setResults] = createSignal<Result[]>([])

  const run = async () => {
    setBusy(true)
    const outcome = await props.odoo
      .reposUpdate({ directory: props.directory, hard: hard() })
      .catch(() => ({ results: [] as Result[], updated: 0, failed: 1 }))
    setBusy(false)
    setRan(true)
    setResults([...outcome.results])
    ctx.toast.show({
      title:
        outcome.failed > 0
          ? `${outcome.updated} ${ctx.t("repoUpdateUpdated")} · ${outcome.failed} ${ctx.t("repoUpdateFailed")}`
          : `${outcome.updated} ${ctx.t("repoUpdateUpdated")}`,
      variant: outcome.failed > 0 ? "error" : "success",
    })
    props.onDone()
  }

  const label = (state: State) => {
    if (state === "updated") return ctx.t("repoUpdateUpdated")
    if (state === "current") return ctx.t("repoUpdateCurrent")
    if (state === "skipped") return ctx.t("repoUpdateSkipped")
    return ctx.t("repoUpdateFailed")
  }
  const color = (state: State) => {
    if (state === "updated") return GREEN
    if (state === "current") return GRAY
    if (state === "skipped") return AMBER
    return RED
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
          <ctx.ui.Button variant="contrast" busy={busy()} onClick={() => void run()}>
            {ran() ? ctx.t("reposUpdateAgain") : ctx.t("reposUpdateRun")}
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
        <Show when={ran()}>
          <Show
            when={results().length > 0}
            fallback={<span class="text-[11px] opacity-40">{ctx.t("reposUpdateEmpty")}</span>}
          >
            <div class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
              <For each={results()}>
                {(entry) => (
                  <div class="flex flex-col gap-0.5 rounded px-1 py-1 text-xs hover:bg-v2-background-bg-layer-02">
                    <div class="flex items-center gap-1">
                      <span
                        class="flex-1 truncate"
                        style={{ "font-family": "var(--font-family-mono, monospace)" }}
                        title={entry.path}
                      >
                        {entry.path}
                      </span>
                      <span class="shrink-0 text-[11px] opacity-40">{entry.branch}</span>
                      <span class="shrink-0 text-[11px]" style={{ color: color(entry.state) }}>
                        {label(entry.state)}
                      </span>
                    </div>
                    <Show when={entry.message !== ""}>
                      <span class="text-[11px]" style={{ color: RED }}>
                        {entry.message}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </ctx.ui.Dialog>
  )
}
