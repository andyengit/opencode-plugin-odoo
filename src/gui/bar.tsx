import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import type { OdooClient, WorkspaceStatus, WorkspaceSummary } from "./contract"

const GREEN = "#22c55e"
const AMBER = "#f59e0b"
const GRAY = "#6b7280"

export function OdooBar(props: {
  odoo: OdooClient
  remembered: () => string | undefined
  onOpen: (directory?: string) => void
}) {
  const ctx = usePlugin()
  const [summary, setSummary] = createSignal<WorkspaceSummary | null | undefined>(undefined)
  const [status, setStatus] = createSignal<WorkspaceStatus | undefined>(undefined)
  const [busy, setBusy] = createSignal<string | undefined>()

  const directory = () => ctx.sessions.current()?.directory ?? props.remembered()

  const load = () => {
    const dir = directory()
    if (!dir) {
      setSummary(undefined)
      setStatus(undefined)
      return
    }
    void props.odoo
      .detect({ directory: dir })
      .then(setSummary)
      .catch(() => setSummary(null))
    void props.odoo
      .status({ directory: dir })
      .then(setStatus)
      .catch(() => setStatus(undefined))
  }

  onMount(() => {
    const timer = setInterval(load, 5000)
    onCleanup(() => clearInterval(timer))
  })
  createKeyed(
    () => directory(),
    () => load(),
    {
      otherwise: () => {
        setSummary(undefined)
        setStatus(undefined)
      },
    },
  )

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    const outcome = await fn().then(
      (message) => ({ message }),
      (error: unknown) => ({ message: String(error) }),
    )
    if (typeof outcome.message === "string" && outcome.message) ctx.toast.show({ title: outcome.message })
    setBusy(undefined)
    load()
  }

  const postgresColor = () => {
    const value = status()?.postgres
    if (value === "running") return GREEN
    if (value === "unhealthy") return AMBER
    return GRAY
  }

  return (
    <div class="flex items-center gap-2 border-t border-v2-border-border-muted px-3 py-1 text-xs">
      <span class="font-medium opacity-70">{ctx.t("title")}</span>

      <Show
        when={summary()}
        fallback={
          <span class="flex-1 opacity-50 truncate">{directory() ? ctx.t("noWorkspace") : ctx.t("pickWorkspace")}</span>
        }
      >
        {(workspace) => {
          const active = () => workspace().activeEnvironment || workspace().environments[0] || ""
          const running = () => {
            const label = active()
            return label ? (status()?.environments.find((item) => item.label === label)?.running ?? false) : false
          }
          const toggle = () => {
            const dir = directory()
            const label = active()
            if (!dir || !label) return
            return run("odoo", () => props.odoo.odoo({ directory: dir, label, action: running() ? "stop" : "start" }))
          }
          return (
            <>
              <span class="opacity-50 truncate max-w-40">{(directory() ?? workspace().root).split("/").pop()}</span>
              <span class="flex items-center gap-1">
                <span
                  class="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ "background-color": postgresColor() }}
                />
                <span class="opacity-50">{ctx.t("postgres")}</span>
              </span>

              <Show when={workspace().environments.length > 0}>
                <Show
                  when={workspace().environments.length > 1}
                  fallback={<span class="opacity-70 truncate max-w-40">{active()}</span>}
                >
                  <ctx.ui.Select
                    options={workspace().environments.map((label) => ({ value: label, label }))}
                    value={active() || undefined}
                    onChange={(label) =>
                      run("conf", () =>
                        props.odoo.setEnvironment({ directory: directory() ?? workspace().root, label }),
                      )
                    }
                    label={ctx.t("environment")}
                  />
                </Show>

                <span
                  class="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ "background-color": running() ? GREEN : GRAY }}
                />
                <ctx.ui.Button size="small" busy={busy() === "odoo"} onClick={() => void toggle()}>
                  {running() ? ctx.t("stop") : ctx.t("start")}
                </ctx.ui.Button>
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
              </Show>
            </>
          )
        }}
      </Show>

      <ctx.ui.Button size="small" variant="ghost" onClick={() => props.onOpen(directory())}>
        {ctx.t("command")}
      </ctx.ui.Button>
    </div>
  )
}
