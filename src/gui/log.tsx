import { createSignal, onCleanup, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { OdooClient } from "./contract"

export function LogView(props: { odoo: OdooClient; directory: string; label: string }) {
  const ctx = usePlugin()
  const [text, setText] = createSignal("")
  let pre: HTMLPreElement | undefined

  const load = () =>
    void props.odoo
      .log({ directory: props.directory, label: props.label })
      .then((next) => {
        setText(next)
        queueMicrotask(() => {
          if (pre) pre.scrollTop = pre.scrollHeight
        })
      })
      .catch((error: unknown) => setText(`(${String(error)})`))

  onMount(() => {
    load()
    const timer = setInterval(load, 1500)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div class="flex flex-col gap-2 min-h-0">
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] opacity-50 truncate">
          {props.directory}/.odoo-run/{props.label}.log
        </span>
        <ctx.ui.IconButton icon="outline-rotate-clockwise" label={ctx.t("refresh")} size="small" onClick={load} />
      </div>
      <pre
        ref={pre}
        class="text-[12px] whitespace-pre-wrap overflow-auto max-h-[60vh] p-2"
        style={{ "font-family": "var(--font-family-mono, monospace)" }}
      >
        {text()}
      </pre>
    </div>
  )
}
