/** Reads the Odoo processes the system reports, without needing a workspace. */

export interface OdooProcessInfo {
  pid: number
  /** The `-c` configuration file, when the command names one. */
  conf: string
  /** The `-d` database, when the command names one. */
  database: string
  /** A short name for the row: the workspace folder and config file, else the database. */
  label: string
}

function argument(command: string, flags: string[]): string {
  for (const flag of flags) {
    const match = new RegExp(
      `(?:^|\\s)${flag}(?:\\s*=\\s*|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s]+))`,
    ).exec(command)
    const value = match?.[1] ?? match?.[2] ?? match?.[3] ?? ""
    if (value !== "") return value
  }
  return ""
}

function folderName(conf: string): string {
  const parts = conf.split("/").filter((part) => part !== "")
  const file = parts.pop() ?? ""
  let folder = parts.pop() ?? ""
  // The usual layout puts the configuration under `<workspace>/config/`.
  if (folder === "config") folder = parts.pop() ?? folder
  return folder === "" ? file : `${folder}/${file}`
}

/** Parses `ps -Ao pid=,command=`, keeping the lines that run `odoo-bin`. */
export function parseProcesses(output: string): OdooProcessInfo[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match) return []
    const pid = Number(match[1])
    const command = match[2] ?? ""
    if (!Number.isInteger(pid) || pid <= 0) return []
    if (!command.includes("odoo-bin")) return []
    // `grep odoo-bin` / `rg odoo-bin` mention the name; they are not Odoo.
    const executable = (command.trim().split(/\s+/)[0] ?? "").split("/").pop() ?? ""
    if (executable === "grep" || executable === "rg") return []
    if (command.includes("ps -Ao")) return []
    const conf = argument(command, ["-c", "--config"])
    const database = argument(command, ["-d", "--database"])
    const label = conf === "" ? database || "odoo" : folderName(conf)
    return [{ pid, conf, database, label }]
  })
}
