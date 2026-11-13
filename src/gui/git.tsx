import { createSignal, For, Show } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import { draftCommitMessage } from "../git"
import type { GitFile, GitState, OdooClient } from "./contract"

const GREEN = "#22c55e"
const AMBER = "#f59e0b"
const RED = "#ef4444"
const BLUE = "#3b82f6"
const GRAY = "#9ca3af"

/** Colour of a status code: added green, deleted red, modified amber, renamed blue, untracked gray. */
const codeColor = (code: string) => {
  if (code.includes("A")) return GREEN
  if (code.includes("D")) return RED
  if (code.includes("R") || code.includes("C")) return BLUE
  if (code.includes("?")) return GRAY
  return AMBER
}

/** Colour of one diff line. */
const diffColor = (line: string) => {
  if (line.startsWith("@@")) return BLUE
  if (line.startsWith("+++") || line.startsWith("---")) return GRAY
  if (line.startsWith("+")) return GREEN
  if (line.startsWith("-")) return RED
  if (line.startsWith("diff ") || line.startsWith("index ")) return GRAY
  return undefined
}

export function GitPanel(props: {
  odoo: OdooClient
  directory: string
  remembered: (directory: string) => string | undefined
  remember: (directory: string, repository: string) => void
}) {
  const ctx = usePlugin()
  const [repos, setRepos] = createSignal<Array<{ path: string; changed: number }>>([])
  const [repo, setRepo] = createSignal("")
  const [state, setState] = createSignal<GitState | undefined>()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [message, setMessage] = createSignal("")
  const [stashMessage, setStashMessage] = createSignal("")
  const [openStaged, setOpenStaged] = createSignal(true)
  const [openChanges, setOpenChanges] = createSignal(true)
  const [openStash, setOpenStash] = createSignal(false)
  const [branchName, setBranchName] = createSignal("")
  const [branchBase, setBranchBase] = createSignal("")
  const [undoCount, setUndoCount] = createSignal(1)
  const [undoLog, setUndoLog] = createSignal<Array<{ hash: string; subject: string }>>([])
  const [focused, setFocused] = createSignal(false)
  let messageArea: HTMLTextAreaElement | undefined

  const staged = () => (state()?.files ?? []).filter((file) => file.staged)
  const changes = () => (state()?.files ?? []).filter((file) => file.worktree)

  const loadState = () =>
    void props.odoo
      .gitState({ directory: props.directory, repository: repo() })
      .then(setState)
      .catch(() => setState(undefined))

  const loadRepos = async () => {
    const result = await props.odoo.gitRepos({ directory: props.directory }).catch(() => ({ repos: [] }))
    setRepos([...result.repos])
    if (!result.repos.some((item) => item.path === repo())) {
      const next =
        result.repos.find((item) => item.path === props.remembered(props.directory))?.path ??
        result.repos.find((item) => item.path === "")?.path ??
        result.repos[0]?.path ??
        ""
      setRepo(next)
      props.remember(props.directory, next)
    }
    loadState()
  }

  const selectRepo = (path: string) => {
    setRepo(path)
    props.remember(props.directory, path)
  }

  createKeyed(
    () => props.directory,
    () => void loadRepos(),
  )
  createKeyed(
    () => repo(),
    () => loadState(),
  )

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key)
    const outcome = await action().catch((error: unknown) => String(error))
    setBusy(undefined)
    ctx.toast.show({ title: outcome })
    loadRepos()
  }

  const label = (path: string) => (path === "" ? ctx.t("gitRoot") : path)

  const toggle = (file: GitFile, stagedSide: boolean) =>
    run(`${stagedSide ? "unstage" : "stage"}:${file.path}`, () =>
      stagedSide
        ? props.odoo.gitUnstage({ directory: props.directory, repository: repo(), paths: [file.path] })
        : props.odoo.gitStage({ directory: props.directory, repository: repo(), paths: [file.path] }),
    )

  const commit = () =>
    run("commit", async () => {
      const outcome = await props.odoo.gitCommit({
        directory: props.directory,
        repository: repo(),
        message: message(),
      })
      if (outcome.startsWith("Committed")) setMessage("")
      return outcome
    })

  const stash = (action: "push" | "pop" | "apply" | "drop", index: number) =>
    run(`stash:${action}:${index}`, async () => {
      const outcome = await props.odoo.gitStash({
        directory: props.directory,
        repository: repo(),
        action,
        index,
        message: stashMessage(),
      })
      if (action === "push" && outcome !== "") setStashMessage("")
      return outcome
    })

  // Writes the message into the field; committing stays the user's call.
  const draftMessage = async () => {
    const session = ctx.sessions.current()
    if (!session) return
    setBusy("ai")
    const stagedDiff = await props.odoo
      .gitStagedDiff({ directory: props.directory, repository: repo() })
      .catch(() => ({ diff: "" }))
    const prompt = `${ctx.t("gitDraftPrompt")}\n\nRepository: ${repo() === "" ? "." : repo()}\n\n${stagedDiff.diff}`
    const model = ctx.screen.current()?.composer.model()
    const call = (input: { prompt: string; model?: { id: string; providerID: string; variant?: string } }) =>
      session.server.client.experimental.generate.text(input).then(
        (result): { text?: string; error?: string } => ({
          text: result.text
            .trim()
            .replace(/^```[a-z]*\n/i, "")
            .replace(/\n```$/, "")
            .trim(),
        }),
        (error: unknown): { text?: string; error?: string } => ({ error: String(error) }),
      )
    // The composer's model first, else the server default.
    const withModel = model
      ? await call({
          prompt,
          model: { id: model.modelID, providerID: model.providerID, variant: model.variant },
        })
      : undefined
    const outcome = withModel?.text ? withModel : await call({ prompt })
    setBusy(undefined)
    if (outcome.text) {
      setMessage(outcome.text)
      messageArea?.focus()
      ctx.toast.show({ title: ctx.t("gitDrafted"), variant: "success" })
      return
    }
    // No model answered: leave a plain message built from the staged files so the field is still useful.
    setMessage(draftCommitMessage(staged()))
    messageArea?.focus()
    ctx.toast.show({
      title: `${ctx.t("gitDraftedBasic")}${outcome.error ? `\n${outcome.error.slice(0, 300)}` : ""}`,
      variant: "error",
    })
  }

  const undoCommit = () => {
    setUndoCount(1)
    setUndoLog([])
    void props.odoo
      .gitLog({ directory: props.directory, repository: repo(), limit: 20 })
      .then((result) => setUndoLog([...result.commits]))
      .catch(() => setUndoLog([]))
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("gitUndo")}
        description={label(repo())}
        footer={
          <>
            <ctx.ui.Button variant="ghost" onClick={dialog.close}>
              {ctx.t("cancel")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="danger"
              disabled={undoLog().length === 0}
              onClick={() => {
                dialog.close()
                void run("undo", () =>
                  props.odoo.gitUndo({ directory: props.directory, repository: repo(), count: undoCount() }),
                )
              }}
            >
              {ctx.t("gitUndo")}
            </ctx.ui.Button>
          </>
        }
      >
        <div class="flex flex-col gap-3">
          <ctx.ui.Select
            options={undoLog().map((_, index) => ({ value: String(index + 1), label: String(index + 1) }))}
            value={String(undoCount())}
            onChange={(value) => setUndoCount(Number(value))}
            label={ctx.t("gitUndoCount")}
          />
          <div class="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
            <For each={undoLog().slice(0, undoCount())}>
              {(commit) => (
                <span class="text-[11px] truncate" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                  <span class="opacity-50">{`${commit.hash} `}</span>
                  {commit.subject}
                </span>
              )}
            </For>
          </div>
          <span class="text-[11px] opacity-60">{ctx.t("gitUndoHint")}</span>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const openDiff = (file: GitFile, stagedSide: boolean) => {
    const [data, setData] = createSignal<{ diff: string } | undefined>()
    void props.odoo
      .gitDiff({ directory: props.directory, repository: repo(), path: file.path, staged: stagedSide })
      .then(setData)
      .catch(() => setData({ diff: "" }))
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={file.path}
        description={`${label(repo())} · ${stagedSide ? ctx.t("gitStaged") : ctx.t("gitChanges")}`}
        size="x-large"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <Show
          when={(data()?.diff ?? "") !== ""}
          fallback={<span class="text-xs opacity-50">{ctx.t("gitNoDiff")}</span>}
        >
          <div
            class="text-[11px] overflow-auto max-h-[60vh] p-2 whitespace-pre"
            style={{ "font-family": "var(--font-family-mono, monospace)" }}
          >
            <For each={(data()?.diff ?? "").split("\n")}>
              {(line) => <div style={{ color: diffColor(line) }}>{line === "" ? " " : line}</div>}
            </For>
          </div>
        </Show>
      </ctx.ui.Dialog>
    ))
  }

  const openBranch = () => {
    setBranchName("")
    setBranchBase(state()?.branch ?? "")
    ctx.dialogs.open((dialog) => {
      const create = () => {
        const target = branchName().trim()
        if (target === "") {
          ctx.toast.show({ title: ctx.t("gitBranchName"), variant: "error" })
          return
        }
        dialog.close()
        void run("branch", () =>
          props.odoo.gitBranch({
            directory: props.directory,
            repository: repo(),
            branch: target,
            base: branchBase(),
          }),
        )
      }
      return (
        <ctx.ui.Dialog
          title={ctx.t("gitNewBranch")}
          description={label(repo())}
          footer={
            <>
              <ctx.ui.Button variant="ghost" onClick={dialog.close}>
                {ctx.t("cancel")}
              </ctx.ui.Button>
              <ctx.ui.Button variant="contrast" onClick={create}>
                {ctx.t("gitCreate")}
              </ctx.ui.Button>
            </>
          }
        >
          <div class="flex flex-col gap-3">
            <ctx.ui.TextInput
              value={branchName()}
              onInput={setBranchName}
              label={ctx.t("gitBranchName")}
              placeholder="feature/partner-import"
              autofocus
              onSubmit={create}
            />
            <ctx.ui.Select
              options={(state()?.branches ?? []).map((branch) => ({ value: branch, label: branch }))}
              value={branchBase()}
              onChange={setBranchBase}
              label={ctx.t("gitBranchFrom")}
            />
          </div>
        </ctx.ui.Dialog>
      )
    })
  }

  const fileRow = (file: GitFile, stagedSide: boolean) => (
    <div class="group flex items-center gap-1 rounded px-1 py-0.5 text-xs hover:bg-v2-background-bg-layer-02">
      <span class="w-4 shrink-0 text-[11px] font-medium" style={{ color: codeColor(file.code) }}>
        {file.code}
      </span>
      <button
        type="button"
        class="flex-1 truncate text-left"
        title={`${file.path} · ${ctx.t("gitShowDiff")}`}
        style={{ "font-family": "var(--font-family-mono, monospace)" }}
        onClick={() => openDiff(file, stagedSide)}
      >
        <span class="opacity-90">{file.path.split("/").pop()}</span>
        <span class="opacity-40">
          {" "}
          {file.path.includes("/") ? `${file.path.slice(0, file.path.lastIndexOf("/") + 1)}` : ""}
        </span>
      </button>
      <ctx.ui.IconButton
        icon={stagedSide ? "minus" : "plus"}
        label={stagedSide ? ctx.t("gitUnstage") : ctx.t("gitStage")}
        size="small"
        variant="ghost"
        busy={busy() === `${stagedSide ? "unstage" : "stage"}:${file.path}`}
        onClick={() => void toggle(file, stagedSide)}
      />
    </div>
  )

  return (
    <div class="flex flex-col gap-2 p-3 min-h-0 overflow-y-auto">
      <div class="flex items-center gap-1">
        <span class="text-[11px] opacity-50 flex-1 px-1">{ctx.t("repos")}</span>
        <ctx.ui.IconButton
          icon="outline-rotate-clockwise"
          label={ctx.t("refresh")}
          size="small"
          onClick={() => void loadRepos()}
        />
      </div>
      <div class="flex flex-col gap-0.5 max-h-40 overflow-y-auto">
        <For each={repos()}>
          {(item) => (
            <button
              type="button"
              class="flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs"
              classList={{ "bg-v2-background-bg-layer-02": repo() === item.path }}
              onClick={() => selectRepo(item.path)}
            >
              <span class="flex-1 truncate" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                {label(item.path)}
              </span>
              <Show when={item.changed > 0}>
                <span class="text-[11px]" style={{ color: AMBER }}>
                  {item.changed}
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <Show when={repos().length > 0} fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitNoRepo")}</span>}>
        <Show when={state()} fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("loading")}</span>}>
          {(value) => (
            <>
              <div class="flex items-center gap-1">
                <ctx.ui.Select
                  options={value().branches.map((branch) => ({ value: branch, label: branch }))}
                  value={value().branch}
                  onChange={(branch) =>
                    void run("checkout", () =>
                      props.odoo.gitCheckout({ directory: props.directory, repository: repo(), branch }),
                    )
                  }
                  label={ctx.t("gitBranch")}
                  class="flex-1"
                />
                <ctx.ui.IconButton icon="branch-out" label={ctx.t("gitNewBranch")} size="small" onClick={openBranch} />
              </div>

              <div class="flex items-center gap-2 px-1 text-[11px] opacity-50">
                <span class="truncate">{value().branch || ctx.t("gitNoBranch")}</span>
                <Show when={value().ahead > 0}>
                  <span style={{ color: GREEN }}>{`↑${value().ahead}`}</span>
                </Show>
                <Show when={value().behind > 0}>
                  <span style={{ color: AMBER }}>{`↓${value().behind}`}</span>
                </Show>
                <span class="flex-1" />
                <span>{`${value().files.length} ${ctx.t("gitChanges")}`}</span>
              </div>
              <Show when={value().head}>
                <div class="flex items-center gap-1 px-1">
                  <span class="flex-1 text-[11px] opacity-40 truncate">{value().head}</span>
                  <ctx.ui.IconButton
                    icon="outline-undo"
                    label={ctx.t("gitUndo")}
                    size="small"
                    variant="ghost"
                    busy={busy() === "undo"}
                    onClick={undoCommit}
                  />
                </div>
              </Show>

              <div class="flex flex-col gap-1 pt-1">
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    class="flex flex-1 items-center gap-1 px-1 text-[11px] opacity-60"
                    onClick={() => setOpenStaged(!openStaged())}
                  >
                    <ctx.ui.Icon name={openStaged() ? "chevron-down" : "chevron-right"} size="small" />
                    {`${ctx.t("gitStaged")} (${staged().length})`}
                  </button>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    busy={busy() === "unstage"}
                    disabled={staged().length === 0}
                    onClick={() =>
                      void run("unstage", () =>
                        props.odoo.gitUnstage({ directory: props.directory, repository: repo(), paths: [] }),
                      )
                    }
                  >
                    {ctx.t("gitUnstageAll")}
                  </ctx.ui.Button>
                </div>
                <Show when={openStaged()}>
                  <Show
                    when={staged().length > 0}
                    fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitNoStaged")}</span>}
                  >
                    <div class="flex flex-col gap-0.5">
                      <For each={staged()}>{(file) => fileRow(file, true)}</For>
                    </div>
                  </Show>
                </Show>
              </div>

              <div class="flex flex-col gap-1 pt-1">
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    class="flex flex-1 items-center gap-1 px-1 text-[11px] opacity-60"
                    onClick={() => setOpenChanges(!openChanges())}
                  >
                    <ctx.ui.Icon name={openChanges() ? "chevron-down" : "chevron-right"} size="small" />
                    {`${ctx.t("gitChanges")} (${changes().length})`}
                  </button>
                  <ctx.ui.Button
                    size="small"
                    variant="ghost"
                    busy={busy() === "stage"}
                    disabled={changes().length === 0}
                    onClick={() =>
                      void run("stage", () =>
                        props.odoo.gitStage({ directory: props.directory, repository: repo(), paths: [] }),
                      )
                    }
                  >
                    {ctx.t("gitStageAll")}
                  </ctx.ui.Button>
                </div>
                <Show when={openChanges()}>
                  <Show
                    when={changes().length > 0}
                    fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitClean")}</span>}
                  >
                    <div class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
                      <For each={changes()}>{(file) => fileRow(file, false)}</For>
                    </div>
                  </Show>
                </Show>
              </div>

              <div class="flex flex-col gap-1 pt-1">
                <textarea
                  ref={(element) => {
                    messageArea = element
                  }}
                  aria-label={ctx.t("gitCommitMessage")}
                  placeholder={ctx.t("gitCommitMessage")}
                  rows={4}
                  value={message()}
                  onInput={(event) => setMessage(event.currentTarget.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault()
                      void commit()
                    }
                  }}
                  style={{
                    "background-color": "var(--v2-background-bg-base)",
                    "box-shadow": "var(--v2-elevation-input)",
                    border: "0",
                    "border-radius": "6px",
                    outline: focused() ? "1px solid var(--v2-border-border-focus)" : "1px solid transparent",
                    "outline-offset": "-1px",
                    padding: "6px 8px",
                    "font-size": "13px",
                    "font-family": "inherit",
                    "line-height": "1.4",
                    resize: "vertical",
                    "min-height": "92px",
                  }}
                />
                <div class="flex items-center justify-end gap-1">
                  <ctx.ui.IconButton
                    icon="brain"
                    label={ctx.t("gitDraft")}
                    size="small"
                    variant="ghost"
                    busy={busy() === "ai"}
                    disabled={staged().length === 0}
                    onClick={() => void draftMessage()}
                  />
                  <ctx.ui.Button
                    size="small"
                    variant="contrast"
                    busy={busy() === "commit"}
                    disabled={message().trim() === "" || staged().length === 0}
                    onClick={() => void commit()}
                  >
                    {staged().length > 0 ? `${ctx.t("gitCommit")} ${staged().length}` : ctx.t("gitCommit")}
                  </ctx.ui.Button>
                </div>
              </div>

              <div class="flex flex-col gap-1 pt-1">
                <button
                  type="button"
                  class="flex items-center gap-1 px-1 text-[11px] opacity-60"
                  onClick={() => setOpenStash(!openStash())}
                >
                  <ctx.ui.Icon name={openStash() ? "chevron-down" : "chevron-right"} size="small" />
                  {`${ctx.t("gitStash")} (${value().stash.length})`}
                </button>
                <Show when={openStash()}>
                  <div class="flex items-center gap-1">
                    <ctx.ui.TextInput
                      value={stashMessage()}
                      onInput={setStashMessage}
                      label={ctx.t("gitStashMessage")}
                      placeholder={ctx.t("gitStashMessage")}
                      class="flex-1"
                    />
                    <ctx.ui.Button
                      size="small"
                      variant="ghost"
                      busy={busy() === "stash:push:0"}
                      disabled={value().files.length === 0}
                      onClick={() => void stash("push", 0)}
                    >
                      {ctx.t("gitStashPush")}
                    </ctx.ui.Button>
                  </div>
                  <For each={value().stash}>
                    {(entry) => (
                      <div class="flex items-center gap-1 px-1 text-xs">
                        <span class="flex-1 truncate opacity-70" title={entry.message}>
                          {`stash@{${entry.index}} ${entry.message}`}
                        </span>
                        <ctx.ui.IconButton
                          icon="arrow-undo-down"
                          label={ctx.t("gitStashPop")}
                          size="small"
                          variant="ghost"
                          busy={busy() === `stash:pop:${entry.index}`}
                          onClick={() => void stash("pop", entry.index)}
                        />
                        <ctx.ui.IconButton
                          icon="download"
                          label={ctx.t("gitStashApply")}
                          size="small"
                          variant="ghost"
                          busy={busy() === `stash:apply:${entry.index}`}
                          onClick={() => void stash("apply", entry.index)}
                        />
                        <ctx.ui.IconButton
                          icon="trash"
                          label={ctx.t("gitStashDrop")}
                          size="small"
                          variant="ghost"
                          busy={busy() === `stash:drop:${entry.index}`}
                          onClick={() => void stash("drop", entry.index)}
                        />
                      </div>
                    )}
                  </For>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}
