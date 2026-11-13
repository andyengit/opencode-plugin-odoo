import { call, type XmlValue } from "./xmlrpc"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/** A live XML-RPC connection. The password only lives in this process' memory. */
export interface RpcConnection {
  name: string
  url: string
  database: string
  username: string
  uid: number
  version: string
  enabled: boolean
  writes: boolean
}

interface StoredConnection extends RpcConnection {
  password: string
}

const connections = new Map<string, StoredConnection>()

function describe(connection: StoredConnection): RpcConnection {
  return {
    name: connection.name,
    url: connection.url,
    database: connection.database,
    username: connection.username,
    uid: connection.uid,
    version: connection.version,
    enabled: connection.enabled,
    writes: connection.writes,
  }
}

export async function rpcConnect(input: {
  url: string
  database: string
  username: string
  password: string
  name?: string
  writes?: boolean
}): Promise<RpcConnection> {
  const url = input.url.trim().replace(/\/+$/, "")
  if (url === "") throw new Error("The URL is empty")
  const uid = await call(`${url}/xmlrpc/2/common`, "authenticate", [input.database, input.username, input.password, {}])
  if (typeof uid !== "number" || uid <= 0) throw new Error("Odoo rejected those credentials (no uid)")
  const version = await call(`${url}/xmlrpc/2/common`, "version", [], 10000).catch(() => null)
  const record = typeof version === "object" && version !== null && !Array.isArray(version) ? version : {}
  const name = input.name?.trim() || `${input.username}@${input.database}`
  connections.set(name, {
    name,
    url,
    database: input.database,
    username: input.username,
    password: input.password,
    uid,
    version: typeof record.server_version === "string" ? record.server_version : "",
    enabled: true,
    writes: input.writes === true,
  })
  return describe(connections.get(name)!)
}

function resolve(name?: string): StoredConnection {
  if (name && name !== "") {
    const found = connections.get(name)
    if (!found) throw new Error(`No XML-RPC connection named "${name}". Use rpc_connections to list them.`)
    return found
  }
  if (connections.size === 1) return [...connections.values()][0]!
  if (connections.size === 0) throw new Error("No XML-RPC connection yet. Call rpc_connect or rpc_use first.")
  throw new Error(`Several connections open: ${[...connections.keys()].join(", ")}. Pass one as "connection".`)
}

/** Where the user stores named connections so their secrets never reach the chat. */
export function credentialsPath(): string {
  return join(homedir(), ".config", "opencode", "odoo-rpc.json")
}

interface SavedConnection {
  url: string
  database: string
  username: string
  password: string
  enabled: boolean
  writes: boolean
}

export function parseSavedConnections(text: string): Record<string, SavedConnection> {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const saved: Record<string, SavedConnection> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue
      const record = value as Record<string, unknown>
      if (
        typeof record.url !== "string" ||
        typeof record.database !== "string" ||
        typeof record.username !== "string" ||
        typeof record.password !== "string"
      ) {
        continue
      }
      saved[name] = {
        url: record.url,
        database: record.database,
        username: record.username,
        password: record.password,
        // A saved connection is on unless turned off; writes stay off until explicitly allowed.
        enabled: typeof record.enabled === "boolean" ? record.enabled : true,
        writes: typeof record.writes === "boolean" ? record.writes : false,
      }
    }
    return saved
  } catch {
    return {}
  }
}

async function readSaved(): Promise<Record<string, SavedConnection>> {
  return parseSavedConnections(await readFile(credentialsPath(), "utf8").catch(() => ""))
}

/** The saved connections, without their passwords. */
export async function savedConnections(): Promise<
  Array<{
    name: string
    url: string
    database: string
    username: string
    enabled: boolean
    writes: boolean
  }>
> {
  const saved = await readSaved()
  return Object.entries(saved).map(([name, value]) => ({
    name,
    url: value.url,
    database: value.database,
    username: value.username,
    enabled: value.enabled,
    writes: value.writes,
  }))
}

/** Connects with the credentials the user stored under `name`, without exposing them. */
export async function rpcUseSaved(name: string): Promise<RpcConnection> {
  const saved = (await readSaved())[name]
  if (!saved) throw new Error(`No saved connection "${name}" in ${credentialsPath()}`)
  if (!saved.enabled) throw new Error(`XML-RPC is disabled for "${name}". Enable it in the plugin panel first.`)
  return rpcConnect({
    url: saved.url,
    database: saved.database,
    username: saved.username,
    password: saved.password,
    name,
    writes: saved.writes,
  })
}

async function ensureConnection(name?: string): Promise<StoredConnection> {
  if (name && name !== "") {
    const existing = connections.get(name)
    if (existing) return existing
    try {
      await rpcUseSaved(name)
      return connections.get(name)!
    } catch {
      throw new Error(`No XML-RPC connection named "${name}". Use rpc_connections or add it to ${credentialsPath()}.`)
    }
  }
  if (connections.size === 0) {
    const saved = await savedConnections()
    if (saved.length === 1) {
      const only = saved[0]!
      await rpcUseSaved(only.name)
      return connections.get(only.name)!
    }
  }
  return resolve(undefined)
}

export function rpcConnections(): RpcConnection[] {
  return [...connections.values()].map(describe)
}

export function rpcDisconnect(name: string): boolean {
  return connections.delete(name)
}

/** Methods that only read data; anything else counts as a write. */
const READ_METHODS = new Set([
  "search",
  "search_read",
  "search_count",
  "read",
  "read_group",
  "web_read",
  "web_search_read",
  "fields_get",
  "name_get",
  "name_search",
  "default_get",
  "exists",
  "get_metadata",
  "check_access_rights",
  "check_access_rule",
])

export function isReadMethod(method: string): boolean {
  return READ_METHODS.has(method)
}

export async function rpcCall(
  name: string | undefined,
  model: string,
  method: string,
  args: readonly unknown[],
  kwargs: Record<string, unknown>,
): Promise<XmlValue> {
  const connection = await ensureConnection(name)
  if (!connection.writes && !isReadMethod(method)) {
    throw new Error(
      `XML-RPC writes are disabled for "${connection.name}". Enable "Allow writes" in the plugin panel to run ${model}.${method}().`,
    )
  }
  return call(`${connection.url}/xmlrpc/2/object`, "execute_kw", [
    connection.database,
    connection.uid,
    connection.password,
    model,
    method,
    args,
    kwargs,
  ])
}
