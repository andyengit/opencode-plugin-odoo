import { createSignal, For, Index, onCleanup, onMount, Show } from "solid-js"
import { createKeyed, usePlugin } from "@opencode/plugin/gui"
import { draftCommitMessage } from "../git"
import type { GitFile, GitState, OdooClient } from "./contract"
import { CloneRepoDialog } from "./clone"
import { buildFileTree, folderFiles, type FolderNode } from "../gitTree"

const GREEN = "#22c55e"
const AMBER = "#f59e0b"
const RED = "#ef4444"
const BLUE = "#3b82f6"
const GRAY = "#9ca3af"

const SECTIONS = [
  { id: "changes", label: "gitWorkingTree", icon: "status" },
  { id: "history", label: "gitHistory", icon: "outline-list-changelog" },
  { id: "stash", label: "gitStash", icon: "archive" },
] as const

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

const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/")
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) }
}

const textareaStyle = (focused: boolean) => ({
  "background-color": "var(--v2-background-bg-base)",
  "box-shadow": "var(--v2-elevation-input)",
  border: "0",
  "border-radius": "6px",
  outline: focused ? "1px solid var(--v2-border-border-focus)" : "1px solid transparent",
  "outline-offset": "-1px",
  padding: "6px 8px",
  "font-size": "13px",
  "font-family": "inherit",
  "line-height": "1.4",
  resize: "vertical" as const,
  "min-height": "92px",
})

export function GitPanel(props: {
  odoo: OdooClient
  directory: string
  remembered: (directory: string) => string | undefined
  remember: (directory: string, repository: string) => void
}) {
  const ctx = usePlugin()
  const [repos, setRepos] = createSignal<Array<{ path: string; changed: number }>>([])
  const [reposLoaded, setReposLoaded] = createSignal(false)
  const [repo, setRepo] = createSignal("")
  const [state, setState] = createSignal<GitState | undefined>()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [message, setMessage] = createSignal("")
  const [drafts, setDrafts] = createSignal<Record<string, string>>({})
  const [section, setSection] = createSignal<(typeof SECTIONS)[number]["id"]>("changes")
  const [stashMessage, setStashMessage] = createSignal("")
  const [branchName, setBranchName] = createSignal("")
  const [branchBase, setBranchBase] = createSignal("")
  const [undoCount, setUndoCount] = createSignal(1)
  const [undoLog, setUndoLog] = createSignal<Array<{ hash: string; subject: string }>>([])
  const [commits, setCommits] = createSignal<
    Array<{ hash: string; subject: string; author: string; date: string }>
  >([])
  const [openStaged, setOpenStaged] = createSignal(true)
  const [openChanges, setOpenChanges] = createSignal(true)
  const [expandedFolders, setExpandedFolders] = createSignal<Record<string, boolean>>({})
  const [hasContext, setHasContext] = createSignal(false)
  const [preStatus, setPreStatus] = createSignal<Awaited<ReturnType<OdooClient["preCommitStatus"]>> | undefined>()
  const [preOutput, setPreOutput] = createSignal("")
  const [preScope, setPreScope] = createSignal<"staged" | "all">("staged")
  const [focused, setFocused] = createSignal(false)
  let messageArea: HTMLTextAreaElement | undefined
  let lastDirectory = props.directory

  const staged = () => (state()?.files ?? []).filter((file) => file.staged)
  const changes = () => (state()?.files ?? []).filter((file) => file.worktree)
  const changedCount = () => (state()?.files ?? []).length
  const draftKey = (path: string) => `${props.directory}\n${path}`
  const repoLabel = (path: string) => (path === "" ? ctx.t("gitRoot") : path)
  const repoShort = (path: string) => (path === "" ? ctx.t("gitRoot") : (path.split("/").pop() ?? path))
  const absolute = (path: string) => `${state()?.root ?? ""}/${path}`
  const statFor = (file: GitFile, stagedSide: boolean) =>
    (state()?.stats ?? []).find((stat) => stat.path === file.path && stat.staged === stagedSide)

  const loadState = () =>
    void props.odoo
      .gitState({ directory: props.directory, repository: repo() })
      .then(setState)
      .catch(() => setState(undefined))

  const loadPreCommit = () =>
    void props.odoo
      .preCommitStatus({ directory: props.directory, repository: repo(), scope: preScope() })
      .then(setPreStatus)
      .catch(() => setPreStatus(undefined))

  const loadLog = () =>
    void props.odoo
      .gitLog({ directory: props.directory, repository: repo(), limit: 30 })
      .then((result) => setCommits([...result.commits]))
      .catch(() => setCommits([]))

  const applyRepo = (path: string, next: Record<string, string>) => {
    setRepo(path)
    setMessage(next[draftKey(path)] ?? "")
    setState(undefined)
    setPreStatus(undefined)
    setPreOutput("")
    setExpandedFolders({})
    props.remember(props.directory, path)
  }

  const selectRepo = (path: string) => {
    if (path === repo()) return
    const next = { ...drafts(), [draftKey(repo())]: message() }
    setDrafts(next)
    applyRepo(path, next)
  }

  const loadRepos = async () => {
    const result = await props.odoo.gitRepos({ directory: props.directory }).catch(() => ({ repos: [] }))
    setRepos([...result.repos])
    setReposLoaded(true)
    if (result.repos.some((item) => item.path === repo())) {
      loadState()
      loadPreCommit()
      return
    }
    const next =
      result.repos.find((item) => item.path === props.remembered(props.directory))?.path ??
      result.repos.find((item) => item.path === "")?.path ??
      result.repos[0]?.path ??
      ""
    const nextDrafts = { ...drafts(), [draftKey(repo())]: message() }
    setDrafts(nextDrafts)
    applyRepo(next, nextDrafts)
    loadState()
  }

  createKeyed(
    () => props.directory,
    () => {
      if (lastDirectory !== props.directory) {
        setDrafts({ ...drafts(), [`${lastDirectory}\n${repo()}`]: message() })
        lastDirectory = props.directory
        setRepo("")
        setMessage("")
      }
      setRepos([])
      setReposLoaded(false)
      setCommits([])
      setState(undefined)
      setSection("changes")
      void props.odoo
        .gitContext({ directory: props.directory, repository: repo() })
        .then((value) => setHasContext(value.text.trim() !== "" || value.file !== ""))
        .catch(() => setHasContext(false))
      void loadRepos()
    },
  )
  createKeyed(
    () => repo(),
    () => {
      loadState()
      loadPreCommit()
    },
  )
  createKeyed(
    () => preScope(),
    () => loadPreCommit(),
  )
  createKeyed(
    () => `${repo()}\n${section()}`,
    () => {
      if (section() === "history") loadLog()
    },
  )

  onMount(() => {
    const states = setInterval(() => {
      if (busy() || repos().length === 0) return
      loadState()
    }, 3000)
    const repositories = setInterval(() => {
      if (!busy()) void loadRepos()
    }, 30000)
    const history = setInterval(() => {
      if (section() === "history" && !busy()) loadLog()
    }, 10000)
    onCleanup(() => {
      clearInterval(states)
      clearInterval(repositories)
      clearInterval(history)
    })
  })

  const run = async (key: string, action: () => Promise<string>) => {
    setBusy(key)
    const outcome = await action().catch((error: unknown) => String(error))
    setBusy(undefined)
    ctx.toast.show({ title: outcome })
    void loadRepos()
    loadPreCommit()
    if (section() === "history") loadLog()
  }

  const openPreReport = (output: string) => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("preCommitReport")}
        description={repoLabel(repo())}
        size="x-large"
        footer={
          <>
            <ctx.ui.Button variant="ghost" onClick={dialog.close}>
              {ctx.t("close")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="ghost"
              icon="copy"
              onClick={() =>
                void ctx.system
                  .copy(output)
                  .then(() => ctx.toast.show({ title: ctx.t("copied") }))
                  .catch(() => undefined)
              }
            >
              {ctx.t("copyLog")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="contrast"
              icon="brain"
              onClick={() => {
                const session = ctx.sessions.current()
                if (!session) {
                  ctx.toast.show({ title: ctx.t("preCommitNoSession"), variant: "error" })
                  return
                }
                ctx.layout.draft({
                  server: session.server.id,
                  directory: state()?.root ?? props.directory,
                  prompt: `${ctx.t("preCommitFixPrompt")}\n\n${output}`,
                })
                dialog.close()
                ctx.toast.show({ title: ctx.t("preCommitDraft") })
              }}
            >
              {ctx.t("preCommitFix")}
            </ctx.ui.Button>
          </>
        }
      >
        <pre
          class="text-[11px] whitespace-pre-wrap overflow-auto max-h-[55vh] p-2"
          style={{
            "font-family": "var(--font-family-mono, monospace)",
            "user-select": "text",
            "-webkit-user-select": "text",
            cursor: "text",
          }}
        >
          {output === "" ? ctx.t("preCommitNoOutput") : output}
        </pre>
      </ctx.ui.Dialog>
    ))
  }

  const runPreCommit = async () => {
    if (busy()) return
    setBusy("precommit")
    const result = await props.odoo
      .preCommitRun({ directory: props.directory, repository: repo(), scope: preScope() })
      .catch((error: unknown) => ({ state: "error" as const, output: String(error), durationMs: 0 }))
    setBusy(undefined)
    setPreOutput(result.output)
    loadPreCommit()
    loadState()
    void loadRepos()
    const ok = result.state === "passed"
    ctx.toast.show({
      title: ok ? ctx.t("preCommitPassed") : ctx.t("preCommitFailed"),
      variant: ok ? "success" : "error",
    })
    if (!ok) openPreReport(result.output)
  }

  const installPreCommit = async () => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("preCommitInstall"),
      description: ctx.t("preCommitInstallHint"),
      confirm: ctx.t("preCommitInstall"),
    })
    if (!ok) return
    const message = await props.odoo
      .preCommitSetup({ directory: props.directory, repository: repo() })
      .catch((error: unknown) => String(error))
    ctx.toast.show({ title: message })
    loadPreCommit()
  }

  const toggle = (file: GitFile, stagedSide: boolean) =>
    run(`${stagedSide ? "unstage" : "stage"}:${file.path}`, () =>
      stagedSide
        ? props.odoo.gitUnstage({ directory: props.directory, repository: repo(), paths: [file.path] })
        : props.odoo.gitStage({ directory: props.directory, repository: repo(), paths: [file.path] }),
    )

  const folderKey = (stagedSide: boolean, path: string) => `${stagedSide ? "s" : "w"}:${path}`
  const folderOpen = (stagedSide: boolean, path: string) => expandedFolders()[folderKey(stagedSide, path)] === true
  const toggleFolder = (stagedSide: boolean, path: string) => {
    const key = folderKey(stagedSide, path)
    setExpandedFolders((current) => ({ ...current, [key]: !current[key] }))
  }
  const runFolder = (node: FolderNode<GitFile>, stagedSide: boolean) => {
    const paths = folderFiles(node).map((file) => file.path)
    if (paths.length === 0) return
    return run(`folder-${stagedSide ? "unstage" : "stage"}:${node.path}`, () =>
      stagedSide
        ? props.odoo.gitUnstage({ directory: props.directory, repository: repo(), paths })
        : props.odoo.gitStage({ directory: props.directory, repository: repo(), paths }),
    )
  }

  const commit = () =>
    run("commit", async () => {
      const outcome = await props.odoo.gitCommit({
        directory: props.directory,
        repository: repo(),
        message: message(),
      })
      if (outcome.startsWith("Committed")) {
        setMessage("")
        setDrafts({ ...drafts(), [draftKey(repo())]: "" })
        loadLog()
      }
      return outcome
    })

  const sync = (action: "fetch" | "pull" | "push") =>
    run(action, () => props.odoo.gitSync({ directory: props.directory, repository: repo(), action }))

  const stash = async (action: "push" | "pop" | "apply" | "drop", index: number) => {
    if (action === "drop") {
      const ok = await ctx.dialogs.confirm({
        title: ctx.t("gitStashDrop"),
        description: `stash@{${index}}`,
        confirm: ctx.t("gitStashDrop"),
        danger: true,
      })
      if (!ok) return
    }
    await run(`stash:${action}:${index}`, async () => {
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
  }

  const discard = async (file: GitFile) => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("gitDiscard"),
      description: `${file.path}\n\n${file.untracked ? ctx.t("gitDiscardUntrackedHint") : ctx.t("gitDiscardHint")}`,
      confirm: ctx.t("gitDiscard"),
      danger: true,
    })
    if (!ok) return
    await run(`discard:${file.path}`, () =>
      props.odoo.gitDiscard({
        directory: props.directory,
        repository: repo(),
        paths: [file.path],
        untracked: file.untracked,
      }),
    )
  }

  // Writes the message into the field; committing stays the user's call.
  const draftMessage = async () => {
    const session = ctx.sessions.current()
    if (!session) return
    setBusy("ai")
    const saved = await props.odoo
      .gitContext({ directory: props.directory, repository: repo() })
      .catch(() => ({ text: "", file: "", content: "" }))
    const rules = [saved.text.trim(), saved.content.trim()].filter((part) => part !== "").join("\n\n").slice(0, 12000)
    const stagedDiff = await props.odoo
      .gitStagedDiff({ directory: props.directory, repository: repo() })
      .catch(() => ({ diff: "" }))
    const prompt = [
      ctx.t("gitDraftPrompt"),
      rules === "" ? "" : `${ctx.t("gitDraftRules")}\n${rules}`,
      `Repository: ${repo() === "" ? "." : repo()}`,
      stagedDiff.diff,
    ]
      .filter((part) => part !== "")
      .join("\n\n")
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
        title={ctx.t("gitUndoMany")}
        description={repoLabel(repo())}
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
              {(entry) => (
                <span class="text-[11px] truncate" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                  <span class="opacity-50">{`${entry.hash} `}</span>
                  {entry.subject}
                </span>
              )}
            </For>
          </div>
          <span class="text-[11px] opacity-60">{ctx.t("gitUndoHint")}</span>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const undoOne = async () => {
    const ok = await ctx.dialogs.confirm({
      title: ctx.t("gitUndoOne"),
      description: `${repoLabel(repo())}\n\n${ctx.t("gitUndoHint")}`,
      confirm: ctx.t("gitUndoOne"),
    })
    if (!ok) return
    await run("undo", () => props.odoo.gitUndo({ directory: props.directory, repository: repo(), count: 1 }))
  }

  const openDiff = (file: GitFile, stagedSide: boolean) => {
    const [data, setData] = createSignal<{ diff: string } | undefined>()
    const [wrap, setWrap] = createSignal(false)
    void props.odoo
      .gitDiff({ directory: props.directory, repository: repo(), path: file.path, staged: stagedSide })
      .then(setData)
      .catch(() => setData({ diff: "" }))
    const lines = () => (data()?.diff ?? "").split("\n")
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={file.path}
        description={`${repoLabel(repo())} · ${stagedSide ? ctx.t("gitStaged") : ctx.t("gitChanges")}`}
        size="x-large"
        footer={
          <>
            <ctx.ui.Button variant="ghost" onClick={dialog.close}>
              {ctx.t("close")}
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="contrast"
              busy={busy() === `${stagedSide ? "unstage" : "stage"}:${file.path}`}
              onClick={() => void toggle(file, stagedSide).then(() => dialog.close())}
            >
              {stagedSide ? ctx.t("gitUnstage") : ctx.t("gitStage")}
            </ctx.ui.Button>
          </>
        }
      >
        <div class="flex flex-col gap-2 min-h-0">
          <div class="flex items-center gap-2 text-[11px] opacity-60">
            <Show when={statFor(file, stagedSide)}>
              {(stat) => (
                <span>
                  <span style={{ color: GREEN }}>{`+${stat().added}`}</span>{" "}
                  <span style={{ color: RED }}>{`-${stat().deleted}`}</span>
                </span>
              )}
            </Show>
            <span class="flex-1" />
            <ctx.ui.Switch label={ctx.t("gitWrap")} hideLabel checked={wrap()} onChange={setWrap} />
            <span>{ctx.t("gitWrap")}</span>
          </div>
          <Show
            when={(data()?.diff ?? "") !== ""}
            fallback={<span class="text-xs opacity-50">{ctx.t("gitNoDiff")}</span>}
          >
            <div
              class={wrap() ? "text-[11px] overflow-auto max-h-[60vh] p-2 whitespace-pre-wrap break-all" : "text-[11px] overflow-auto max-h-[60vh] p-2 whitespace-pre"}
              style={{
                "font-family": "var(--font-family-mono, monospace)",
                "user-select": "text",
                "-webkit-user-select": "text",
                cursor: "text",
              }}
            >
              <Index each={lines()}>
                {(line) => <div style={{ color: diffColor(line()) }}>{line() === "" ? " " : line()}</div>}
              </Index>
            </div>
          </Show>
        </div>
      </ctx.ui.Dialog>
    ))
  }

  const openCommit = (entry: { hash: string; subject: string; author: string; date: string }) => {
    const [data, setData] = createSignal<{ stat: string; diff: string } | undefined>()
    void props.odoo
      .gitShow({ directory: props.directory, repository: repo(), hash: entry.hash })
      .then(setData)
      .catch(() => setData({ stat: "", diff: "" }))
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={entry.subject || entry.hash}
        description={`${entry.hash} · ${[entry.author, entry.date].filter(Boolean).join(" · ")}`}
        size="x-large"
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <Show when={data()} fallback={<span class="text-xs opacity-50">{ctx.t("loading")}</span>}>
          {(value) => (
            <div class="flex flex-col gap-2 min-h-0">
              <Show when={value().stat !== ""}>
                <pre
                  class="text-[11px] whitespace-pre-wrap max-h-40 overflow-auto p-2"
                  style={{
                    "font-family": "var(--font-family-mono, monospace)",
                    "user-select": "text",
                    "-webkit-user-select": "text",
                    cursor: "text",
                  }}
                >
                  {value().stat}
                </pre>
              </Show>
              <div
                class="text-[11px] overflow-auto max-h-[50vh] p-2 whitespace-pre"
                style={{
                  "font-family": "var(--font-family-mono, monospace)",
                  "user-select": "text",
                  "-webkit-user-select": "text",
                  cursor: "text",
                }}
              >
                <Index each={value().diff.split("\n")}>
                  {(line) => <div style={{ color: diffColor(line()) }}>{line() === "" ? " " : line()}</div>}
                </Index>
              </div>
            </div>
          )}
        </Show>
      </ctx.ui.Dialog>
    ))
  }

  const openClone = () => {
    ctx.dialogs.open((dialog) => (
      <CloneRepoDialog
        odoo={props.odoo}
        directory={props.directory}
        close={dialog.close}
        onDone={() => {
          void loadRepos()
          loadState()
        }}
      />
    ))
  }

  const openRepos = () => {
    ctx.dialogs.open((dialog) => {
      const [query, setQuery] = createSignal("")
      const visible = () => {
        const search = query().toLowerCase()
        return repos()
          .filter((item) => repoLabel(item.path).toLowerCase().includes(search))
          .sort((a, b) => {
            const changed = Number(b.changed > 0) - Number(a.changed > 0)
            return changed !== 0 ? changed : repoLabel(a.path).localeCompare(repoLabel(b.path))
          })
      }
      return (
        <ctx.ui.Dialog
          title={ctx.t("gitReposTitle")}
          size="normal"
          footer={
            <ctx.ui.Button variant="contrast" onClick={dialog.close}>
              {ctx.t("close")}
            </ctx.ui.Button>
          }
        >
          <div class="flex flex-col gap-2">
            <div class="flex items-end gap-1">
              <ctx.ui.TextInput
                value={query()}
                onInput={setQuery}
                label={ctx.t("gitSearchRepos")}
                placeholder={ctx.t("gitSearchRepos")}
                autofocus
                class="flex-1"
              />
              <ctx.ui.Button
                size="small"
                variant="ghost"
                icon="download"
                onClick={() => {
                  dialog.close()
                  openClone()
                }}
              >
                {ctx.t("cloneRepo")}
              </ctx.ui.Button>
            </div>
            <div class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
              <Show
                when={visible().length > 0}
                fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitNoRepo")}</span>}
              >
                <For each={visible()}>
                  {(item) => (
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-v2-background-bg-layer-02"
                      classList={{ "bg-v2-background-bg-layer-02": repo() === item.path }}
                      onClick={() => {
                        selectRepo(item.path)
                        dialog.close()
                      }}
                    >
                      <span class="flex-1 truncate" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
                        {repoLabel(item.path)}
                      </span>
                      <Show when={item.changed > 0}>
                        <span class="text-[11px]" style={{ color: AMBER }}>
                          {item.changed}
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </ctx.ui.Dialog>
      )
    })
  }

  const openContext = () => {
    ctx.dialogs.open((dialog) => {
      const [text, setText] = createSignal("")
      const [file, setFile] = createSignal("")
      const [content, setContent] = createSignal("")
      const [found, setFound] = createSignal(true)
      const [contextFocused, setContextFocused] = createSignal(false)
      void props.odoo
        .gitContext({ directory: props.directory, repository: repo() })
        .then((value) => {
          setText(value.text)
          setFile(value.file)
          setContent(value.content)
          if (value.file !== "") void loadContent(value.file)
        })
        .catch(() => undefined)
      async function loadContent(path: string) {
        const value = await props.odoo
          .gitContextFile({ directory: props.directory, repository: repo(), file: path })
          .catch(() => ({ content: "", found: false }))
        setContent(value.content)
        setFound(value.found)
      }
      const pick = async () => {
        const [picked] = (await ctx.desktop?.pick({ title: ctx.t("gitContextFile") }).catch(() => [])) ?? []
        if (!picked) return
        setFile(picked)
        await loadContent(picked)
      }
      const save = async () => {
        const outcome = await props.odoo
          .gitContextSet({ directory: props.directory, text: text(), file: file() })
          .catch((error: unknown) => String(error))
        setHasContext(text().trim() !== "" || file() !== "")
        ctx.toast.show({ title: outcome })
        dialog.close()
      }
      return (
        <ctx.ui.Dialog
          title={ctx.t("gitContextTitle")}
          description={ctx.t("gitContextHint")}
          size="large"
          footer={
            <>
              <ctx.ui.Button variant="ghost" onClick={dialog.close}>
                {ctx.t("cancel")}
              </ctx.ui.Button>
              <ctx.ui.Button variant="contrast" onClick={() => void save()}>
                {ctx.t("save")}
              </ctx.ui.Button>
            </>
          }
        >
          <div class="flex flex-col gap-3">
            <textarea
              aria-label={ctx.t("gitContextRules")}
              placeholder={ctx.t("gitContextExampleText")}
              rows={6}
              ref={(element) => queueMicrotask(() => element.focus())}
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
              onFocus={() => setContextFocused(true)}
              onBlur={() => setContextFocused(false)}
              style={textareaStyle(contextFocused())}
            />
            <div class="flex items-end gap-1">
              <ctx.ui.TextInput
                value={file()}
                onInput={setFile}
                onSubmit={(value) => void loadContent(value)}
                label={ctx.t("gitContextFile")}
                placeholder=".agents/skills/commits/SKILL.md"
                class="flex-1"
              />
              <ctx.ui.Button
                size="small"
                variant="ghost"
                icon="folder"
                disabled={!ctx.desktop}
                onClick={() => void pick()}
              >
                {ctx.t("gitContextPick")}
              </ctx.ui.Button>
              <ctx.ui.Button
                size="small"
                variant="ghost"
                onClick={() => setText(ctx.t("gitContextExampleText"))}
              >
                {ctx.t("gitContextExample")}
              </ctx.ui.Button>
            </div>
            <span class="text-[11px] opacity-50">{ctx.t("gitContextFileHint")}</span>
            <Show when={file() !== "" && !found()}>
              <span class="text-[11px]" style={{ color: AMBER }}>
                {ctx.t("gitContextFileMissing")}
              </span>
            </Show>
            <Show when={content() !== ""}>
              <pre
                class="text-[11px] whitespace-pre-wrap max-h-24 overflow-auto p-2"
                style={{
                  "font-family": "var(--font-family-mono, monospace)",
                  "user-select": "text",
                  "-webkit-user-select": "text",
                  cursor: "text",
                }}
              >
                {content()}
              </pre>
            </Show>
          </div>
        </ctx.ui.Dialog>
      )
    })
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
          description={repoLabel(repo())}
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

  const fileRow = (file: GitFile, stagedSide: boolean, depth = 0) => {
    const parts = splitPath(file.path)
    const stat = () => statFor(file, stagedSide)
    return (
      <div
        class="group flex items-center gap-1 rounded pr-1 py-1 text-xs hover:bg-v2-background-bg-layer-02"
        style={{ "padding-left": `${4 + depth * 12}px` }}
      >
        <span class="w-5 shrink-0 text-[11px] font-medium" style={{ color: codeColor(file.code) }}>
          {file.code}
        </span>
        <button
          type="button"
          class="flex min-w-0 flex-1 items-baseline gap-1 text-left"
          title={`${file.path} · ${ctx.t("gitShowDiff")}`}
          onClick={() => openDiff(file, stagedSide)}
        >
          <span class="truncate opacity-90" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
            {parts.name}
          </span>
          <span class="truncate text-[11px] opacity-40">{parts.dir}</span>
          <Show when={!file.untracked && stat()}>
            {(value) => (
              <span class="shrink-0 text-[11px]">
                <span style={{ color: GREEN }}>{`+${value().added}`}</span>{" "}
                <span style={{ color: RED }}>{`-${value().deleted}`}</span>
              </span>
            )}
          </Show>
          <Show when={file.untracked}>
            <span class="shrink-0 text-[11px]" style={{ color: GRAY }}>
              {ctx.t("gitNew")}
            </span>
          </Show>
        </button>
        <ctx.ui.Tooltip value={stagedSide ? ctx.t("gitUnstage") : ctx.t("gitStage")}>
          <ctx.ui.IconButton
            icon={stagedSide ? "minus" : "plus"}
            label={stagedSide ? ctx.t("gitUnstage") : ctx.t("gitStage")}
            size="small"
            variant="ghost"
            busy={busy() === `${stagedSide ? "unstage" : "stage"}:${file.path}`}
            onClick={() => void toggle(file, stagedSide)}
          />
        </ctx.ui.Tooltip>
        <ctx.ui.Menu
          label={ctx.t("gitFileActions")}
          items={[
            { label: ctx.t("gitShowDiff"), icon: "eye", onSelect: () => openDiff(file, stagedSide) },
            {
              label: stagedSide ? ctx.t("gitUnstage") : ctx.t("gitStage"),
              icon: stagedSide ? "minus" : "plus",
              onSelect: () => void toggle(file, stagedSide),
            },
            { label: ctx.t("gitCopyPath"), icon: "copy", onSelect: () => void ctx.system.copy(file.path) },
            {
              label: ctx.t("gitReveal"),
              icon: "folder",
              disabled: !ctx.desktop,
              onSelect: () => {
                if (ctx.desktop) void ctx.desktop.reveal(absolute(file.path))
              },
            },
            { label: ctx.t("gitDiscard"), icon: "trash", onSelect: () => void discard(file) },
          ]}
        />
      </div>
    )
  }

  const folderRow = (node: FolderNode<GitFile>, stagedSide: boolean, depth: number) => {
    const count = folderFiles(node).length
    return (
      <div
        class="flex items-center gap-1 rounded pr-1 py-1 text-xs hover:bg-v2-background-bg-layer-02"
        style={{ "padding-left": `${4 + depth * 12}px` }}
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-1 text-left"
          onClick={() => toggleFolder(stagedSide, node.path)}
        >
          <ctx.ui.Icon name={folderOpen(stagedSide, node.path) ? "chevron-down" : "chevron-right"} size="small" />
          <ctx.ui.Icon name="folder" size="small" />
          <span class="truncate opacity-80" style={{ "font-family": "var(--font-family-mono, monospace)" }}>
            {`${node.name}/`}
          </span>
          <span class="shrink-0 text-[11px] opacity-40">{count}</span>
        </button>
        <ctx.ui.Tooltip value={stagedSide ? ctx.t("gitUnstageFolder") : ctx.t("gitStageFolder")}>
          <ctx.ui.IconButton
            icon={stagedSide ? "minus" : "plus"}
            label={stagedSide ? ctx.t("gitUnstageFolder") : ctx.t("gitStageFolder")}
            size="small"
            variant="ghost"
            busy={busy() === `folder-${stagedSide ? "unstage" : "stage"}:${node.path}`}
            onClick={() => void runFolder(node, stagedSide)}
          />
        </ctx.ui.Tooltip>
      </div>
    )
  }

  const renderFolder = (node: FolderNode<GitFile>, stagedSide: boolean, depth: number) => (
    <>
      {folderRow(node, stagedSide, depth)}
      <Show when={folderOpen(stagedSide, node.path)}>
        <For each={node.folders}>{(child) => renderFolder(child, stagedSide, depth + 1)}</For>
        <For each={node.files}>{(file) => fileRow(file, stagedSide, depth + 1)}</For>
      </Show>
    </>
  )

  const renderTree = (files: GitFile[], stagedSide: boolean) => {
    const tree = buildFileTree(files)
    return (
      <>
        <For each={tree.folders}>{(node) => renderFolder(node, stagedSide, 0)}</For>
        <For each={tree.files}>{(file) => fileRow(file, stagedSide, 0)}</For>
      </>
    )
  }

  const preLabel = () => {
    const status = preStatus()
    if (!status) return ctx.t("loading")
    const base = !status.configured
      ? ctx.t("preCommitMissing")
      : status.state === "passed"
        ? ctx.t("preCommitPassed")
        : status.state === "failed"
          ? ctx.t("preCommitFailed")
          : status.state === "error"
            ? ctx.t("preCommitError")
            : ctx.t("preCommitNotRun")
    return status.outdated ? `${base} · ${ctx.t("preCommitOutdated")}` : base
  }

  const preColor = () => {
    const status = preStatus()
    if (!status) return GRAY
    if (status.outdated) return AMBER
    if (status.state === "passed") return GREEN
    if (status.state === "failed") return RED
    if (status.state === "missing" || status.state === "error") return AMBER
    return GRAY
  }

  return (
    <div class="flex flex-col gap-2 p-3 min-h-0">
      <div class="flex items-center gap-1">
        <ctx.ui.Button
          size="small"
          variant="ghost"
          icon="folder"
          class="min-w-0 flex-1 justify-start"
          onClick={openRepos}
        >
          <span class="truncate">{repoShort(repo())}</span>
          <Show when={changedCount() > 0}>
            <span class="text-[11px]" style={{ color: AMBER }}>
              {changedCount()}
            </span>
          </Show>
        </ctx.ui.Button>
        <ctx.ui.Tooltip value={ctx.t("refresh")}>
          <ctx.ui.IconButton
            icon="outline-rotate-clockwise"
            label={ctx.t("refresh")}
            size="small"
            onClick={() => {
              void loadRepos()
              loadState()
            }}
          />
        </ctx.ui.Tooltip>
        <ctx.ui.Menu
          label={ctx.t("gitMore")}
          items={[
            { label: ctx.t("gitContext"), icon: "outline-sliders", onSelect: openContext },
            {
              label: ctx.t("gitCopyPath"),
              icon: "copy",
              onSelect: () => void ctx.system.copy(state()?.root ?? ""),
            },
            {
              label: ctx.t("gitReveal"),
              icon: "folder",
              disabled: !ctx.desktop,
              onSelect: () => {
                const root = state()?.root
                if (root && ctx.desktop) void ctx.desktop.reveal(root)
              },
            },
            {
              label: ctx.t("gitUndoOne"),
              icon: "outline-undo",
              disabled: !state()?.head,
              onSelect: () => void undoOne(),
            },
            { label: ctx.t("gitUndoMany"), icon: "outline-undo", disabled: !state()?.head, onSelect: undoCommit },
          ]}
        />
      </div>

      <div class="flex flex-wrap gap-1">
        <For each={SECTIONS}>
          {(item) => (
            <button
              type="button"
              class="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px]"
              classList={{
                "bg-v2-background-bg-layer-02": section() === item.id,
                "opacity-55": section() !== item.id,
              }}
              aria-pressed={section() === item.id}
              onClick={() => setSection(item.id)}
            >
              <ctx.ui.Icon name={item.icon} size="small" />
              {ctx.t(item.label)}
            </button>
          )}
        </For>
      </div>

      <div class="flex flex-col gap-2 min-h-0 flex-1 overflow-y-auto">
        <Show when={reposLoaded()} fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("loading")}</span>}>
        <Show when={repos().length > 0} fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitNoRepo")}</span>}>
          <Show when={state()} fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("loading")}</span>}>
            {(value) => (
              <>
                <div class="flex items-center gap-1">
                  <ctx.ui.Select
                    options={((value().branches ?? []).includes(value().branch) || value().branch === ""
                      ? value().branches ?? []
                      : [value().branch, ...(value().branches ?? [])]
                    ).map((branch) => ({ value: branch, label: branch }))}
                    value={value().branch || undefined}
                    onChange={(branch) =>
                      void run("checkout", () =>
                        props.odoo.gitCheckout({ directory: props.directory, repository: repo(), branch }),
                      )
                    }
                    label={ctx.t("gitBranch")}
                    class="flex-1"
                  />
                  <ctx.ui.IconButton
                    icon="branch-out"
                    label={ctx.t("gitNewBranch")}
                    size="small"
                    onClick={openBranch}
                  />
                </div>

                <div class="flex items-center gap-1">
                  <span class="flex-1 text-[11px] opacity-50 truncate">
                    {value().upstream || ctx.t("gitNoUpstream")}
                  </span>
                  <Show when={value().ahead > 0}>
                    <span class="text-[11px]" style={{ color: GREEN }}>{`↑${value().ahead}`}</span>
                  </Show>
                  <Show when={value().behind > 0}>
                    <span class="text-[11px]" style={{ color: AMBER }}>{`↓${value().behind}`}</span>
                  </Show>
                  <ctx.ui.Tooltip value={ctx.t("gitFetch")}>
                    <ctx.ui.IconButton
                      icon="download"
                      label={ctx.t("gitFetch")}
                      size="small"
                      busy={busy() === "fetch"}
                      onClick={() => void sync("fetch")}
                    />
                  </ctx.ui.Tooltip>
                  <ctx.ui.Tooltip value={ctx.t("gitPull")}>
                    <ctx.ui.IconButton
                      icon="arrow-down-to-line"
                      label={ctx.t("gitPull")}
                      size="small"
                      busy={busy() === "pull"}
                      onClick={() => void sync("pull")}
                    />
                  </ctx.ui.Tooltip>
                  <ctx.ui.Tooltip value={ctx.t("gitPush")}>
                    <ctx.ui.IconButton
                      icon="cloud-upload"
                      label={ctx.t("gitPush")}
                      size="small"
                      busy={busy() === "push"}
                      onClick={() => void sync("push")}
                    />
                  </ctx.ui.Tooltip>
                </div>

                <Show when={!!value().operation}>
                  <div class="flex items-center gap-1 px-1 text-[11px]" style={{ color: AMBER }}>
                    <ctx.ui.Icon name="warning" size="small" />
                    {`${ctx.t("gitOperation")}: ${value().operation ?? ""}`}
                  </div>
                </Show>
                <Show when={value().operation === undefined}>
                  <span class="text-[11px] px-1" style={{ color: AMBER }}>
                    {ctx.t("gitStaleHint")}
                  </span>
                </Show>

                <Show when={section() === "changes"}>
                  <Show
                    when={(value().files ?? []).length > 0}
                    fallback={
                      <div class="flex flex-col items-center gap-2 py-6 text-center">
                        <ctx.ui.Icon name="circle-check" size="large" />
                        <span class="text-xs opacity-60">{ctx.t("gitClean")}</span>
                      </div>
                    }
                  >
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
                            {renderTree(staged(), true)}
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
                            {renderTree(changes(), false)}
                          </div>
                        </Show>
                      </Show>
                    </div>

                    <div class="flex flex-col gap-2 pt-1">
                      <div class="flex flex-wrap items-center gap-1 px-1 text-[11px]">
                        <span class="h-2 w-2 shrink-0 rounded-full" style={{ "background-color": preColor() }} />
                        <span class="flex-1 truncate opacity-70">{`${ctx.t("preCommit")} · ${preLabel()}`}</span>
                        <Show when={preOutput() !== ""}>
                          <ctx.ui.Tooltip value={ctx.t("preCommitReport")}>
                            <ctx.ui.IconButton
                              icon="console"
                              label={ctx.t("preCommitReport")}
                              size="small"
                              variant="ghost"
                              onClick={() => openPreReport(preOutput())}
                            />
                          </ctx.ui.Tooltip>
                        </Show>
                        <Show when={preStatus()?.configured}>
                          <ctx.ui.Select
                            options={[
                              { value: "staged", label: ctx.t("preCommitStaged") },
                              { value: "all", label: ctx.t("preCommitAll") },
                            ]}
                            value={preScope()}
                            onChange={(value) => setPreScope(value as "staged" | "all")}
                            label={ctx.t("preCommitScope")}
                            class="shrink-0"
                          />
                        </Show>
                        <ctx.ui.Button
                          size="small"
                          variant="ghost"
                          icon="checklist"
                          busy={busy() === "precommit"}
                          disabled={busy() !== undefined && busy() !== "precommit"}
                          onClick={() => void (preStatus()?.configured ? runPreCommit() : installPreCommit())}
                        >
                          {preStatus()?.configured ? ctx.t("preCommitRunShort") : ctx.t("preCommitInstall")}
                        </ctx.ui.Button>
                      </div>
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
                        style={textareaStyle(focused())}
                      />
                      <div class="flex items-center gap-1">
                        <span class="text-[11px] opacity-40 px-1">{message().length}</span>
                        <span class="flex-1 text-[11px] opacity-30 text-right pr-1">
                          {ctx.t("gitCommitHint")}
                        </span>
                        <ctx.ui.Tooltip value={ctx.t("gitContext")}>
                          <ctx.ui.IconButton
                            icon="outline-sliders"
                            label={ctx.t("gitContext")}
                            size="small"
                            variant="ghost"
                            pressed={hasContext()}
                            onClick={openContext}
                          />
                        </ctx.ui.Tooltip>
                        <ctx.ui.Button
                          size="small"
                          variant="ghost"
                          icon="brain"
                          busy={busy() === "ai"}
                          disabled={staged().length === 0}
                          onClick={() => void draftMessage()}
                        >
                          {ctx.t("gitDraft")}
                        </ctx.ui.Button>
                        <ctx.ui.Button
                          size="small"
                          variant="contrast"
                          busy={busy() === "commit"}
                          disabled={message().trim() === "" || staged().length === 0}
                          onClick={() => void commit()}
                        >
                          {staged().length > 0
                            ? `${ctx.t("gitCommit")} (${staged().length})`
                            : ctx.t("gitCommit")}
                        </ctx.ui.Button>
                      </div>
                    </div>
                  </Show>
                </Show>

                <Show when={section() === "history"}>
                  <div class="flex items-center gap-1 pt-1">
                    <span class="flex-1 text-[11px] opacity-50 px-1">{ctx.t("gitHistory")}</span>
                    <ctx.ui.Tooltip value={ctx.t("gitUndoOne")}>
                      <ctx.ui.IconButton
                        icon="outline-undo"
                        label={ctx.t("gitUndoOne")}
                        size="small"
                        variant="ghost"
                        disabled={!value().head}
                        onClick={() => void undoOne()}
                      />
                    </ctx.ui.Tooltip>
                    <ctx.ui.Tooltip value={ctx.t("refresh")}>
                      <ctx.ui.IconButton
                        icon="outline-rotate-clockwise"
                        label={ctx.t("refresh")}
                        size="small"
                        variant="ghost"
                        onClick={loadLog}
                      />
                    </ctx.ui.Tooltip>
                  </div>
                  <Show
                    when={commits().length > 0}
                    fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitNoHistory")}</span>}
                  >
                    <div class="flex flex-col gap-0.5">
                      <For each={commits()}>
                        {(entry) => (
                          <button
                            type="button"
                            class="flex flex-col gap-0.5 rounded px-1 py-1 text-left hover:bg-v2-background-bg-layer-02"
                            onClick={() => openCommit(entry)}
                          >
                            <span class="flex min-w-0 items-baseline gap-1">
                              <span
                                class="shrink-0 text-[11px] opacity-50"
                                style={{ "font-family": "var(--font-family-mono, monospace)" }}
                              >
                                {entry.hash}
                              </span>
                              <span class="truncate">{entry.subject}</span>
                            </span>
                            <span class="text-[11px] opacity-40">
                              {[entry.author, entry.date].filter(Boolean).join(" · ")}
                            </span>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>

                <Show when={section() === "stash"}>
                  <div class="flex items-center gap-1 pt-1">
                    <ctx.ui.TextInput
                      value={stashMessage()}
                      onInput={setStashMessage}
                      label={ctx.t("gitStashMessage")}
                      placeholder={ctx.t("gitStashMessage")}
                      class="flex-1"
                    />
                    <ctx.ui.Button
                      size="small"
                      variant="contrast"
                      busy={busy() === "stash:push:0"}
                      disabled={(value().files ?? []).length === 0}
                      onClick={() => void stash("push", 0)}
                    >
                      {ctx.t("gitStashPush")}
                    </ctx.ui.Button>
                  </div>
                  <Show
                    when={(value().stash ?? []).length > 0}
                    fallback={<span class="text-[11px] opacity-40 px-1">{ctx.t("gitNoStash")}</span>}
                  >
                    <div class="flex flex-col gap-0.5">
                      <For each={value().stash ?? []}>
                        {(entry) => (
                          <div class="flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-v2-background-bg-layer-02">
                            <span class="flex-1 truncate opacity-70" title={entry.message}>
                              {`stash@{${entry.index}} ${entry.message}`}
                            </span>
                            <ctx.ui.Tooltip value={ctx.t("gitStashPop")}>
                              <ctx.ui.IconButton
                                icon="arrow-undo-down"
                                label={ctx.t("gitStashPop")}
                                size="small"
                                variant="ghost"
                                busy={busy() === `stash:pop:${entry.index}`}
                                onClick={() => void stash("pop", entry.index)}
                              />
                            </ctx.ui.Tooltip>
                            <ctx.ui.Tooltip value={ctx.t("gitStashApply")}>
                              <ctx.ui.IconButton
                                icon="download"
                                label={ctx.t("gitStashApply")}
                                size="small"
                                variant="ghost"
                                busy={busy() === `stash:apply:${entry.index}`}
                                onClick={() => void stash("apply", entry.index)}
                              />
                            </ctx.ui.Tooltip>
                            <ctx.ui.Tooltip value={ctx.t("gitStashDrop")}>
                              <ctx.ui.IconButton
                                icon="trash"
                                label={ctx.t("gitStashDrop")}
                                size="small"
                                variant="ghost"
                                busy={busy() === `stash:drop:${entry.index}`}
                                onClick={() => void stash("drop", entry.index)}
                              />
                            </ctx.ui.Tooltip>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </Show>
        </Show>
      </div>
    </div>
  )
}
