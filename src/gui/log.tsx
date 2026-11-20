import { createSignal, Index, onCleanup, onMount } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { OdooClient } from "./contract"
import { logSegments } from "../logs"

/** A colored log body for a `<pre>`: one row per line, keyed by position. */
export function LogLines(props: { lines: readonly string[] }) {
  return (
    <Index each={props.lines}>
      {(line) => (
        <div>
          <Index each={logSegments(line())}>
            {(segment) => (
              <span style={{ color: segment().color, "font-weight": segment().bold ? "600" : undefined }}>
                {segment().text}
              </span>
            )}
          </Index>
          {line() === "" ? "\u00a0" : ""}
        </div>
      )}
    </Index>
  )
}

export function LogView(props: { odoo: OdooClient; directory: string; label: string }) {
  const ctx = usePlugin()
  const [text, setText] = createSignal("")
  const [path, setPath] = createSignal("")
  let pre: HTMLPreElement | undefined

  const load = () =>
    void props.odoo
      .log({ directory: props.directory, label: props.label })
      .then((next) => {
        setText(next?.text ?? "")
        setPath(next?.path ?? "")
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
        <span class="text-[11px] opacity-50 truncate">{path() || `${props.directory}/.odoo-run/${props.label}.log`}</span>
        <div class="flex items-center gap-1">
          <ctx.ui.Tooltip value={ctx.t("copyLog")}>
            <ctx.ui.IconButton
              icon="copy"
              label={ctx.t("copyLog")}
              size="small"
              variant="ghost"
              onClick={() =>
                void ctx.system
                  .copy(text())
                  .then(() => ctx.toast.show({ title: ctx.t("copied") }))
                  .catch(() => undefined)
              }
            />
          </ctx.ui.Tooltip>
          <ctx.ui.IconButton icon="outline-rotate-clockwise" label={ctx.t("refresh")} size="small" onClick={load} />
        </div>
      </div>
      <pre
        ref={pre}
        class="text-[12px] whitespace-pre-wrap overflow-auto max-h-[60vh] p-2"
        style={{
          "font-family": "var(--font-family-mono, monospace)",
          "user-select": "text",
          "-webkit-user-select": "text",
          cursor: "text",
        }}
      >
        <LogLines lines={text().split("\n")} />
      </pre>
    </div>
  )
}
