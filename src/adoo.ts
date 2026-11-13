/**
 * adoo.live OAuth 2.0 device flow. The client is public (no secret), so the device endpoint plus a
 * refresh token is all the plugin needs. Nothing here logs a token.
 */

const BASE = "https://adoo.live"
const CLIENT_ID = "adoo_opencode"
export const ADOO_SCOPE = "profile read database"

export interface AdooTokens {
  accessToken: string
  refreshToken: string
  /** Epoch milliseconds; the access token is renewed at or after it. */
  expiresAt: number
  scope: string
}

export interface AdooDevice {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresIn: number
  interval: number
}

export type AdooTokenResult =
  | { state: "ok"; tokens: AdooTokens }
  | { state: "pending" }
  | { state: "slow_down" }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "error"; message: string }

export type AdooFetcher = (input: string, init?: RequestInit) => Promise<Response>

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString()
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => "")
  if (text.trim() === "") return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

export async function requestDevice(fetcher: AdooFetcher = fetch): Promise<AdooDevice> {
  const response = await fetcher(`${BASE}/api/v1/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form({ client_id: CLIENT_ID, scope: ADOO_SCOPE }),
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(`adoo.live rejected the device request (${response.status})`)
  const deviceCode = text(body.device_code)
  const userCode = text(body.user_code)
  if (deviceCode === "" || userCode === "") throw new Error("adoo.live returned an incomplete device response")
  return {
    deviceCode,
    userCode,
    verificationUri: text(body.verification_uri) || `${BASE}/oauth/device`,
    verificationUriComplete: text(body.verification_uri_complete) || text(body.verification_uri),
    expiresIn: number(body.expires_in, 600),
    interval: Math.max(number(body.interval, 5), 1),
  }
}

export function parseTokens(body: Record<string, unknown>, now = Date.now()): AdooTokens | undefined {
  const accessToken = text(body.access_token)
  const refreshToken = text(body.refresh_token)
  if (accessToken === "" || refreshToken === "") return
  return {
    accessToken,
    refreshToken,
    expiresAt: now + number(body.expires_in, 3600) * 1000,
    scope: text(body.scope) || ADOO_SCOPE,
  }
}

export async function pollDevice(fetcher: AdooFetcher = fetch, deviceCode: string): Promise<AdooTokenResult> {
  const response = await fetcher(`${BASE}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: CLIENT_ID,
    }),
  })
  const body = await readJson(response)
  if (response.ok) {
    const tokens = parseTokens(body)
    return tokens ? { state: "ok", tokens } : { state: "error", message: "adoo.live returned an incomplete token" }
  }
  switch (text(body.error)) {
    case "authorization_pending":
      return { state: "pending" }
    case "slow_down":
      return { state: "slow_down" }
    case "access_denied":
      return { state: "denied" }
    case "expired_token":
      return { state: "expired" }
    default:
      return {
        state: "error",
        message: text(body.error_description) || text(body.error) || `adoo.live refused the token (${response.status})`,
      }
  }
}

export async function refreshTokens(fetcher: AdooFetcher = fetch, refreshToken: string): Promise<AdooTokenResult> {
  const response = await fetcher(`${BASE}/api/v1/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID }),
  })
  const body = await readJson(response)
  if (response.ok) {
    const tokens = parseTokens(body)
    return tokens ? { state: "ok", tokens } : { state: "error", message: "adoo.live returned an incomplete token" }
  }
  if (text(body.error) === "invalid_grant") return { state: "denied" }
  return {
    state: "error",
    message: text(body.error_description) || text(body.error) || `adoo.live refused the refresh (${response.status})`,
  }
}

export async function revokeToken(fetcher: AdooFetcher = fetch, token: string): Promise<void> {
  await fetcher(`${BASE}/api/v1/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form({ token, client_id: CLIENT_ID }),
  })
}

export interface AdooResponse {
  status: number
  body: unknown
}

export async function apiGet(fetcher: AdooFetcher = fetch, path: string, accessToken: string): Promise<AdooResponse> {
  const response = await fetcher(`${BASE}${path}`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  })
  return { status: response.status, body: await readJson(response) }
}

export async function apiPost(
  fetcher: AdooFetcher = fetch,
  path: string,
  accessToken: string,
  body: unknown,
): Promise<AdooResponse> {
  const response = await fetcher(`${BASE}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await readJson(response) }
}

/** The raw download response, so the caller can stream it to disk. */
export function apiDownload(fetcher: AdooFetcher = fetch, path: string, accessToken: string): Promise<Response> {
  const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${BASE}${path}`
  return fetcher(url, { headers: { accept: "*/*", authorization: `Bearer ${accessToken}` } })
}

export interface AdooProfile {
  sub: string
  email: string
  name: string
  role: string
}

export function parseProfile(body: unknown): AdooProfile {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}
  return {
    sub: text(record.sub),
    email: text(record.email),
    name: text(record.name),
    role: text(record.role),
  }
}

export interface AdooItem {
  id: string
  label: string
  detail: string
  url: string
  database: string
  stack: string
  type: string
}

/** Turns an API list into rows the panel can draw without knowing each resource's shape. */
export function normalizeItems(body: unknown): AdooItem[] {
  if (!Array.isArray(body)) return []
  return body.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return []
    const record = entry as Record<string, unknown>
    const id = text(record.id) || text(record.slug) || text(record.name)
    if (id === "") return []
    const label = text(record.name) || text(record.slug) || text(record.host) || id
    const detail = [
      text(record.env_type),
      text(record.odoo_version),
      text(record.stack_name),
      text(record.stack_reference),
      text(record.domain),
      text(record.access_url),
      text(record.host),
      text(record.status),
      text(record.run_state),
    ]
      .filter((part, index, all) => part !== "" && all.indexOf(part) === index)
      .join(" · ")
    return [
      {
        id,
        label,
        detail,
        url: text(record.access_url),
        database: text(record.db_name) || text(record.database_name),
        stack: text(record.stack_id),
        type: text(record.env_type),
      },
    ]
  })
}

/**
 * The Odoo database of an environment. The list endpoint omits it, so it comes from the environment detail,
 * where adoo names the database after the environment's domain (for example `cliente.com`).
 */
export function environmentDatabase(body: unknown): string {
  if (typeof body !== "object" || body === null) return ""
  const record = body as Record<string, unknown>
  return text(record.db_name)
}
