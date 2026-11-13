import { Schema } from "effect"
import {
  Command,
  ComposerPill,
  createKeyed,
  MenuItem,
  Panel,
  Slot,
  TitlebarItem,
  type ComposerPillView,
  type PanelTab,
  type Plugin,
} from "@opencode/plugin/gui"
import { Odoo } from "./contract"
import { OdooBar } from "./bar"
import { GitPanel } from "./git"
import OdooControls from "./controls"

const setup: Plugin.Setup = (ctx) => {
  const odoo = ctx.main(Odoo)
  const lastDir = ctx.storage.store("lastDir", { schema: Schema.Struct({ dir: Schema.String }), initial: { dir: "" } })
  const gitRepo = ctx.storage.store("gitRepo", {
    schema: Schema.Record(Schema.String, Schema.String),
    initial: {},
  })
  const remembered = () => lastDir.value?.dir || undefined
  const opened = new Set<string>()

  const rememberIfOdoo = async (directory: string) => {
    const summary = await odoo.detect({ directory }).catch(() => null)
    if (summary) lastDir.set({ dir: directory })
  }

  // Drop a stored directory that is not an Odoo workspace (e.g. a worktree recorded before validation).
  createKeyed(
    () => remembered(),
    (dir) => {
      void odoo.detect({ directory: dir }).then(
        (summary) => {
          if (!summary && remembered() === dir) lastDir.set({ dir: "" })
        },
        () => undefined,
      )
    },
  )

  const share = (directory: string) => {
    ctx.sessions
      .list()
      .filter((session) => session.location?.directory === directory)
      .forEach((session) => ctx.layout.open("odoo:main", session))
  }

  const openDialogFor = (directory: string) => {
    ctx.dialogs.open((dialog) => (
      <ctx.ui.Dialog
        title={ctx.t("title")}
        description={directory}
        footer={
          <ctx.ui.Button variant="contrast" onClick={dialog.close}>
            {ctx.t("close")}
          </ctx.ui.Button>
        }
      >
        <OdooControls odoo={odoo} directory={directory} />
      </ctx.ui.Dialog>
    ))
  }

  const openDialog = async () => {
    const directory = remembered() ?? (await ctx.desktop?.pick({ directory: true, title: ctx.t("pickWorkspace") }))?.[0]
    if (!directory) {
      ctx.toast.show({ title: ctx.t("noSession") })
      return
    }
    void rememberIfOdoo(directory)
    openDialogFor(directory)
  }

  const openPanel = () => {
    const current = ctx.sessions.current()
    if (!current) {
      void openDialog()
      return
    }
    void rememberIfOdoo(current.directory)
    share(current.directory)
    ctx.layout.open("odoo:main", current)
  }

  // When a session mounts in an Odoo workspace, show its controls once and share them with the workspace's sessions.
  createKeyed(
    () => ctx.sessions.current(),
    (session) => {
      if (!session || opened.has(session.key)) return
      void odoo.detect({ directory: session.directory }).then(
        (summary) => {
          if (!summary || ctx.signal.aborted) return
          opened.add(session.key)
          lastDir.set({ dir: session.directory })
          share(session.directory)
          ctx.layout.open("odoo:main", session)
        },
        () => undefined,
      )
    },
    { equals: (previous, next) => previous?.key === next?.key },
  )

  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("title")
    },
  }

  ctx.add(Panel, {
    id: "main",
    region: "side",
    mobile: { title: ctx.t("title"), order: 0, kind: "tab", icon: "cube" },
    list: (input) => (input.open.includes("main") ? [tab] : []),
    render: (props) => <OdooControls odoo={odoo} directory={props.session.directory} />,
  })

  const gitTab: PanelTab = {
    id: "git",
    get title() {
      return ctx.t("git")
    },
  }

  ctx.add(Panel, {
    id: "git",
    region: "side",
    mobile: { title: ctx.t("git"), order: 10, kind: "tab", icon: "branch" },
    list: (input) => (input.open.includes("git") ? [gitTab] : []),
    render: (props) => (
      <GitPanel
        odoo={odoo}
        directory={props.session.directory}
        remembered={(directory) => gitRepo.value?.[directory]}
        remember={(directory, repository) =>
          gitRepo.update((draft) => {
            draft[directory] = repository
          })
        }
      />
    ),
  })

  const openGit = () => {
    const current = ctx.sessions.current()
    if (!current) return
    ctx.layout.open("odoo:git", current)
  }

  ctx.add(ComposerPill, {
    id: "odoo",
    order: 20,
    show: (): ComposerPillView => ({
      label: ctx.t("title"),
      title: ctx.t("description"),
      icon: "cube",
      run: openPanel,
    }),
  })

  ctx.add(
    TitlebarItem,
    (): TitlebarItem => ({
      id: "odoo",
      label: ctx.t("title"),
      title: ctx.t("description"),
      icon: "cube",
      run: () => void openDialog(),
    }),
  )

  ctx.add(Slot, {
    at: "window.bottom",
    render: () => (
      <OdooBar
        odoo={odoo}
        remembered={remembered}
        onOpen={(directory) => (directory ? openDialogFor(directory) : void openDialog())}
      />
    ),
  })

  ctx.add(MenuItem, {
    menu: "session.panel",
    id: "odoo",
    order: 10,
    title: ctx.t("title"),
    icon: "cube",
    run: openPanel,
  })

  ctx.add(Command, () => ({
    id: "open",
    title: ctx.t("command"),
    run: openPanel,
  }))

  ctx.add(MenuItem, {
    menu: "session.panel",
    id: "git",
    order: 20,
    title: ctx.t("git"),
    icon: "branch",
    run: openGit,
  })

  ctx.add(Command, () => ({
    id: "git",
    title: ctx.t("gitCommand"),
    run: openGit,
  }))
}

export default setup
