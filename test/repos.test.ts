import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { parseEnvironmentRepos, parseStackRepos, repoFolder, repoLocation, sameCommit, sshUrl } from "../src/repos"

describe("parseStackRepos", () => {
  test("reads the stack's configured repositories", () => {
    const repos = parseStackRepos({
      addon_repos: [
        { name: "server-tools", url: "https://github.com/OCA/server-tools", branch: "18.0" },
        { url: "https://github.com/poweredbyandy/odoo-addons.git" },
      ],
    })
    expect(repos).toEqual([
      { name: "server-tools", url: "https://github.com/OCA/server-tools", branch: "18.0", auth: "public" },
      {
        name: "odoo-addons",
        url: "https://github.com/poweredbyandy/odoo-addons.git",
        branch: "",
        auth: "public",
      },
    ])
  })

  test("keeps the authentication mode of private repositories", () => {
    const repos = parseStackRepos({
      addon_repos: [{ url: "https://github.com/poweredbyandy/payroll", git_auth_mode: "deploy_key", branch: "18.0" }],
    })
    expect(repos[0]?.auth).toBe("deploy_key")
  })

  test("accepts a bare list and skips entries without a URL", () => {
    const repos = parseStackRepos([{ url: "https://github.com/OCA/web" }, { name: "empty" }, "nope"])
    expect(repos.map((repo) => repo.name)).toEqual(["web"])
  })

  test("returns nothing for an unexpected payload", () => {
    expect(parseStackRepos({ detail: "Not authenticated" })).toEqual([])
  })
})

describe("repoLocation", () => {
  test("reads HTTPS repositories", () => {
    expect(repoLocation("https://github.com/OCA/server-tools.git")).toEqual({
      org: "oca",
      name: "server-tools",
    })
  })

  test("reads scp-like and ssh repositories", () => {
    expect(repoLocation("git@github.com:poweredbyandy/odoo-addons.git")).toEqual({
      org: "poweredbyandy",
      name: "odoo-addons",
    })
    expect(repoLocation("ssh://git@gitlab.com/team/repo.git")).toEqual({ org: "team", name: "repo" })
  })

  test("drops query strings and fragments", () => {
    expect(repoLocation("https://github.com/OCA/web?ref=18.0#readme")).toEqual({ org: "oca", name: "web" })
  })

  test("rejects a URL without an organization", () => {
    expect(repoLocation("https://github.com")).toBeUndefined()
  })
})

describe("sshUrl", () => {
  test("turns an HTTPS repository into an scp-like SSH URL", () => {
    expect(sshUrl("https://github.com/poweredbyandy/payroll.git")).toBe("git@github.com:poweredbyandy/payroll.git")
  })

  test("keeps the organization's case and other hosts", () => {
    expect(sshUrl("https://github.com/OCA/server-tools")).toBe("git@github.com:OCA/server-tools.git")
    expect(sshUrl("https://gitlab.com/team/repo")).toBe("git@gitlab.com:team/repo.git")
  })

  test("returns nothing for an unusable URL", () => {
    expect(sshUrl("not-a-url")).toBeUndefined()
  })
})

describe("repoFolder", () => {
  test("groups clones by organization under repo/", () => {
    expect(repoFolder("/w", "https://github.com/OCA/server-tools")).toEqual({
      path: join("/w", "repo", "oca", "server-tools"),
      relative: join("repo", "oca", "server-tools"),
    })
  })

  test("returns nothing for an unusable URL", () => {
    expect(repoFolder("/w", "not-a-url")).toBeUndefined()
  })
})

describe("parseEnvironmentRepos", () => {
  test("reads the configured commit of each environment repository", () => {
    const repos = parseEnvironmentRepos({
      unified_repos: [
        {
          row_id: "r1",
          name: "payroll",
          url: "https://github.com/poweredbyandy/payroll",
          branch: "18.0",
          configured_commit: "0123456789abcdef",
        },
        { name: "legacy", url: "https://github.com/OCA/web", commit: "ffeeddcc" },
        { name: "no-url" },
        "nope",
      ],
    })
    expect(repos).toEqual([
      {
        name: "payroll",
        url: "https://github.com/poweredbyandy/payroll",
        branch: "18.0",
        commit: "0123456789abcdef",
      },
      { name: "legacy", url: "https://github.com/OCA/web", branch: "", commit: "ffeeddcc" },
    ])
  })

  test("returns nothing for an unexpected payload", () => {
    expect(parseEnvironmentRepos({ detail: "Not authenticated" })).toEqual([])
  })
})

describe("sameCommit", () => {
  test("matches a full hash against an abbreviated one", () => {
    expect(sameCommit("0123456789ab", "0123456789abcdef0123456789abcdef01234567")).toBe(true)
  })

  test("rejects different commits", () => {
    expect(sameCommit("0123456789ab", "ff23456789abcdef0123456789abcdef01234567")).toBe(false)
  })

  test("rejects missing or too-short hashes", () => {
    expect(sameCommit("", "01234567")).toBe(false)
    expect(sameCommit("0123", "01234567")).toBe(false)
  })
})
