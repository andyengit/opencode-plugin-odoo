import { createSignal } from "solid-js"
import { usePlugin } from "@opencode/plugin/gui"
import type { OdooClient } from "./contract"

/** `repo/<org>/<name>` a URL would clone into, for a small live hint. */
export function cloneDestination(url: string): string {
  const clean = url.trim().replace(/\.git$/, "")
  if (clean === "") return ""
  const parts = clean
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .split(/[/:]/)
    .filter((part) => part !== "")
  const tail = parts.slice(-2)
  return tail.length === 2 ? `repo/${(tail[0] ?? "").toLowerCase()}/${tail[1]}` : ""
}

export function CloneRepoDialog(props: {
  odoo: OdooClient
  directory: string
  close: () => void
  onDone: () => void
}) {
  const ctx = usePlugin()
  const [url, setUrl] = createSignal("")
  const [branch, setBranch] = createSignal("")
  const [ssh, setSsh] = createSignal(false)
  const [addons, setAddons] = createSignal(true)
  const [busy, setBusy] = createSignal(false)

  const clone = async () => {
    if (url().trim() === "" || busy()) return
    setBusy(true)
    const result = await props.odoo
      .cloneRepo({
        directory: props.directory,
        url: url(),
        branch: branch(),
        ssh: ssh(),
        addons: addons(),
      })
      .catch((error: unknown) => ({ ok: false, message: String(error), relative: "" }))
    setBusy(false)
    ctx.toast.show({ title: result.message, variant: result.ok ? "success" : "error" })
    if (!result.ok) return
    props.close()
    props.onDone()
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("cloneRepo")}
      description={ctx.t("cloneHint")}
      footer={
        <>
          <ctx.ui.Button variant="ghost" onClick={props.close}>
            {ctx.t("cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button
            variant="contrast"
            busy={busy()}
            disabled={url().trim() === ""}
            onClick={() => void clone()}
          >
            {ctx.t("cloneNow")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <ctx.ui.TextInput
          value={url()}
          onInput={setUrl}
          label={ctx.t("cloneUrl")}
          placeholder={ctx.t("cloneUrlPlaceholder")}
          autofocus
          onSubmit={() => void clone()}
        />
        <ctx.ui.TextInput
          value={branch()}
          onInput={setBranch}
          label={ctx.t("cloneBranch")}
          placeholder="main"
          onSubmit={() => void clone()}
        />
        <ctx.ui.Switch
          label={ctx.t("cloneSsh")}
          description={ctx.t("cloneSshHint")}
          checked={ssh()}
          onChange={setSsh}
        />
        <ctx.ui.Switch
          label={ctx.t("cloneAddons")}
          description={ctx.t("cloneAddonsHint")}
          checked={addons()}
          onChange={setAddons}
        />
        <span class="text-[11px] opacity-50" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
          {cloneDestination(url()) === ""
            ? ctx.t("cloneDestinationHint")
            : `${ctx.t("cloneDestination")}: ${cloneDestination(url())}`}
        </span>
      </div>
    </ctx.ui.Dialog>
  )
}
