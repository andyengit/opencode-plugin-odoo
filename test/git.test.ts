import { describe, expect, test } from "bun:test"
import { draftCommitMessage, parseAheadBehind, parseGitBranches, parseGitStash, parseGitStatus } from "../src/git"

describe("parseGitStatus", () => {
  test("reads staged, unstaged and untracked files", () => {
    const files = parseGitStatus(["M  app/models/partner.py", " M web/static/src/x.js", "?? new/file.xml"].join("\n"))
    expect(files).toEqual([
      { path: "app/models/partner.py", code: "M", staged: true, worktree: false, untracked: false },
      { path: "web/static/src/x.js", code: "M", staged: false, worktree: true, untracked: false },
      { path: "new/file.xml", code: "??", staged: false, worktree: true, untracked: true },
    ])
  })

  test("keeps the new name of a renamed file", () => {
    expect(parseGitStatus("R  old/name.py -> new/name.py")[0]?.path).toBe("new/name.py")
  })

  test("ignores blank and short lines", () => {
    expect(parseGitStatus("\n \n")).toEqual([])
  })
})

describe("parseGitBranches", () => {
  test("lists branches without blanks", () => {
    expect(parseGitBranches("main\nfeature\n\n")).toEqual(["main", "feature"])
  })
})

describe("parseGitStash", () => {
  test("reads the index and the message", () => {
    expect(parseGitStash("stash@{0}\tWIP on main: 1a2b3c4 fix\nstash@{1}\tWIP on dev: add partner")).toEqual([
      { index: 0, message: "WIP on main: 1a2b3c4 fix" },
      { index: 1, message: "WIP on dev: add partner" },
    ])
  })

  test("skips lines without a stash reference", () => {
    expect(parseGitStash("no stash")).toEqual([])
  })
})

describe("parseAheadBehind", () => {
  test("reads the two counts", () => {
    expect(parseAheadBehind("3\t1")).toEqual({ ahead: 3, behind: 1 })
  })

  test("falls back to zero without an upstream", () => {
    expect(parseAheadBehind("")).toEqual({ ahead: 0, behind: 0 })
  })
})

describe("draftCommitMessage", () => {
  test("builds a conventional subject and lists the files", () => {
    expect(
      draftCommitMessage([
        { path: "models/partner.py", code: "M", staged: true, worktree: false, untracked: false },
        { path: "views/partner.xml", code: "M", staged: true, worktree: false, untracked: false },
      ]),
    ).toBe("fix: update partner\n\n- M models/partner.py\n- M views/partner.xml")
  })

  test("keeps a shared scope and picks feat for added files", () => {
    expect(
      draftCommitMessage([
        { path: "currency_account/new.py", code: "A", staged: true, worktree: false, untracked: false },
      ]),
    ).toBe("feat(currency_account): update new\n\n- A currency_account/new.py")
  })

  test("uses chore when files are removed", () => {
    expect(draftCommitMessage([{ path: "old.py", code: "D", staged: true, worktree: false, untracked: false }])).toBe(
      "chore: update old\n\n- D old.py",
    )
  })

  test("returns nothing without files", () => {
    expect(draftCommitMessage([])).toBe("")
  })
})
