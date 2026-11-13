import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getString, parseOdooConfig, serializeOdooConfig, setString } from "./config"
import { findFreePort } from "./ports"

const HTTP_BASE = 8069
const DB_BASE = 5432

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function containerName(directory: string): string {
  const name = (directory.split("/").pop() || "odoo")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return `odoo-pgdb-${name}`.slice(0, 63)
}

function composeFile(directory: string, dbPort: number): string {
  return `services:
  pgdb:
    image: pgvector/pgvector:pg17
    container_name: ${containerName(directory)}
    restart: unless-stopped
    ports:
      - "${dbPort}:5432"
    environment:
      POSTGRES_USER: odoo
      POSTGRES_PASSWORD: odoo
      POSTGRES_DB: postgres
    volumes:
      - pgdb-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U odoo -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  pgdb-data:
`
}

function odooConf(directory: string, dbPort: number, httpPort: number): string {
  return `[options]
addons_path = ${directory}/custom
data_dir = ${directory}/.odoo-data
db_host = 127.0.0.1
db_port = ${dbPort}
db_user = odoo
db_password = odoo
list_db = True
http_enable = True
http_port = ${httpPort}
workers = 0
`
}

async function confPorts(directory: string): Promise<{ dbPort?: number; httpPorts: Set<number> }> {
  const configDir = join(directory, "config")
  const names = (await readdir(configDir).catch(() => [])).filter((name) => name.endsWith(".conf"))
  let dbPort: number | undefined
  const httpPorts = new Set<number>()
  for (const name of names) {
    const config = parseOdooConfig(await readFile(join(configDir, name), "utf8").catch(() => ""))
    const db = Number(getString(config, "db_port"))
    if (dbPort === undefined && db) dbPort = db
    const http = Number(getString(config, "http_port"))
    if (http) httpPorts.add(http)
  }
  return { dbPort, httpPorts }
}

async function freeHttpPort(exclude: Set<number>): Promise<number> {
  let port = HTTP_BASE
  while (true) {
    const free = await findFreePort(port)
    if (!exclude.has(free)) return free
    port = free + 1
  }
}

export async function createWorkspace(directory: string): Promise<string[]> {
  const created: string[] = []
  const dbPort = await findFreePort(DB_BASE)
  const httpPort = await findFreePort(HTTP_BASE)
  const write = async (path: string, content: string) => {
    if (await exists(path)) return
    await writeFile(path, content)
    created.push(path)
  }

  await mkdir(join(directory, "config"), { recursive: true })
  await mkdir(join(directory, "custom"), { recursive: true })

  await write(join(directory, "docker-compose.yml"), composeFile(directory, dbPort))
  await write(join(directory, "config", "odoo.conf"), odooConf(directory, dbPort, httpPort))
  await write(
    join(directory, ".gitignore"),
    ".odoo-data/\n.venv/\n.odoo-run/\n/bin/\n/backups/\n/odoo/\n__pycache__/\n*.pyc\n",
  )

  return created
}

export function confLabel(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "odoo"
}

export async function createConf(directory: string, name: string): Promise<string | undefined> {
  const safe = confLabel(name)
  const path = join(directory, "config", `${safe}.conf`)
  if (await exists(path)) return undefined
  const { dbPort, httpPorts } = await confPorts(directory)
  const resolvedDb = dbPort ?? (await findFreePort(DB_BASE))
  const httpPort = await freeHttpPort(new Set(httpPorts))
  await mkdir(join(directory, "config"), { recursive: true })
  await writeFile(path, odooConf(directory, resolvedDb, httpPort))
  return path
}

/** Reassigns a free Postgres port and a distinct free HTTP port per conf, so a workspace never conflicts. */
export async function reconfigureWorkspace(directory: string): Promise<{ dbPort: number; httpPorts: number[] }> {
  const dbPort = await findFreePort(DB_BASE)

  const composePath = join(directory, "docker-compose.yml")
  const compose = await readFile(composePath, "utf8").catch(() => "")
  if (compose) {
    const next = compose.replace(/(-\s*"?)\d+(:5432"?)/, `$1${dbPort}$2`)
    if (next !== compose) await writeFile(composePath, next)
  }

  const configDir = join(directory, "config")
  const names = (await readdir(configDir).catch(() => [])).filter((name) => name.endsWith(".conf"))
  const used = new Set<number>()
  const httpPorts: number[] = []
  for (const name of names) {
    const path = join(configDir, name)
    const config = parseOdooConfig(await readFile(path, "utf8").catch(() => ""))
    const httpPort = await freeHttpPort(used)
    used.add(httpPort)
    httpPorts.push(httpPort)
    setString(config, "db_port", String(dbPort))
    setString(config, "http_port", String(httpPort))
    await writeFile(path, serializeOdooConfig(config))
  }

  return { dbPort, httpPorts }
}
