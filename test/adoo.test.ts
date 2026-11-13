import { describe, expect, test } from "bun:test"
import {
  environmentDatabase,
  normalizeItems,
  parseProfile,
  pollDevice,
  refreshTokens,
  requestDevice,
  revokeToken,
  type AdooFetcher,
} from "../src/adoo"

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function recorder(responses: Array<Response>): {
  fetcher: AdooFetcher
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: AdooFetcher = async (url, init) => {
    calls.push({ url, init })
    return responses.shift() ?? json({})
  }
  return { fetcher, calls }
}

describe("requestDevice", () => {
  test("asks for the public client and the read scope", async () => {
    const { fetcher, calls } = recorder([
      json({
        device_code: "dc",
        user_code: "AB-CD",
        verification_uri: "https://adoo.live/oauth/device",
        verification_uri_complete: "https://adoo.live/oauth/device?code=AB-CD",
        expires_in: 600,
        interval: 5,
      }),
    ])
    const device = await requestDevice(fetcher)
    expect(device.userCode).toBe("AB-CD")
    expect(device.verificationUriComplete).toBe("https://adoo.live/oauth/device?code=AB-CD")
    expect(device.expiresIn).toBe(600)
    expect(device.interval).toBe(5)
    expect(calls[0]?.url).toBe("https://adoo.live/api/v1/oauth/device")
    const body = String(calls[0]?.init?.body)
    expect(body).toContain("client_id=adoo_opencode")
    expect(body).toContain("scope=profile+read")
  })

  test("rejects an incomplete device response", async () => {
    const { fetcher } = recorder([json({ user_code: "AB" })])
    await expect(requestDevice(fetcher)).rejects.toThrow("incomplete")
  })
})

describe("pollDevice", () => {
  test("maps the device-flow errors", async () => {
    const cases: Array<[Response, string]> = [
      [json({ error: "authorization_pending" }, 400), "pending"],
      [json({ error: "slow_down" }, 400), "slow_down"],
      [json({ error: "access_denied" }, 400), "denied"],
      [json({ error: "expired_token" }, 400), "expired"],
    ]
    for (const [response, state] of cases) {
      const { fetcher } = recorder([response])
      expect((await pollDevice(fetcher, "dc")).state).toBe(state)
    }
  })

  test("keeps both tokens and the scope on success", async () => {
    const { fetcher, calls } = recorder([
      json({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "profile read" }),
    ])
    const result = await pollDevice(fetcher, "dc")
    expect(result.state).toBe("ok")
    if (result.state !== "ok") return
    expect(result.tokens.accessToken).toBe("at")
    expect(result.tokens.refreshToken).toBe("rt")
    expect(result.tokens.scope).toBe("profile read")
    expect(result.tokens.expiresAt).toBeGreaterThan(Date.now())
    expect(String(calls[0]?.init?.body)).toContain("device_code=dc")
  })

  test("reports an unknown error with the server description", async () => {
    const { fetcher } = recorder([json({ error: "invalid_request", error_description: "bad scope" }, 400)])
    const result = await pollDevice(fetcher, "dc")
    expect(result).toEqual({ state: "error", message: "bad scope" })
  })
})

describe("refreshTokens", () => {
  test("replaces both tokens", async () => {
    const { fetcher, calls } = recorder([json({ access_token: "at2", refresh_token: "rt2", expires_in: 60 })])
    const result = await refreshTokens(fetcher, "rt1")
    expect(result.state).toBe("ok")
    if (result.state !== "ok") return
    expect(result.tokens.refreshToken).toBe("rt2")
    expect(String(calls[0]?.init?.body)).toContain("grant_type=refresh_token")
    expect(String(calls[0]?.init?.body)).toContain("refresh_token=rt1")
  })

  test("treats invalid_grant as a revoked authorization", async () => {
    const { fetcher } = recorder([json({ error: "invalid_grant" }, 400)])
    expect((await refreshTokens(fetcher, "rt")).state).toBe("denied")
  })
})

describe("revokeToken", () => {
  test("posts the token to the revocation endpoint", async () => {
    const { fetcher, calls } = recorder([json({})])
    await revokeToken(fetcher, "rt")
    expect(calls[0]?.url).toBe("https://adoo.live/api/v1/oauth/revoke")
    const body = String(calls[0]?.init?.body)
    expect(body).toContain("token=rt")
    expect(body).toContain("client_id=adoo_opencode")
  })
})

describe("normalizeItems", () => {
  test("labels projects and environments from their fields", () => {
    const items = normalizeItems([
      { id: "p1", name: "Acme", stack_name: "Odoo 18", stack_reference: "prod" },
      {
        id: "e1",
        name: "acme-prod",
        env_type: "production",
        odoo_version: "18.0",
        domain: "acme.adoo.live",
        access_url: "https://acme.adoo.live",
        db_name: "acme_prod",
        stack_id: "s1",
      },
      { host: "10.0.0.1", name: "srv-1" },
      "ignored",
    ])
    expect(items).toEqual([
      { id: "p1", label: "Acme", detail: "Odoo 18 · prod", url: "", database: "", stack: "", type: "" },
      {
        id: "e1",
        label: "acme-prod",
        detail: "production · 18.0 · acme.adoo.live · https://acme.adoo.live",
        url: "https://acme.adoo.live",
        database: "acme_prod",
        stack: "s1",
        type: "production",
      },
      { id: "srv-1", label: "srv-1", detail: "10.0.0.1", url: "", database: "", stack: "", type: "" },
    ])
  })

  test("returns nothing for a non-list payload", () => {
    expect(normalizeItems({ detail: "Not authenticated" })).toEqual([])
  })
})

describe("environmentDatabase", () => {
  test("reads the database name from the environment detail", () => {
    expect(environmentDatabase({ id: "e1", db_name: "cliente.com" })).toBe("cliente.com")
  })

  test("returns nothing when the payload has no database", () => {
    expect(environmentDatabase({ id: "e1" })).toBe("")
    expect(environmentDatabase(null)).toBe("")
  })
})

describe("parseProfile", () => {
  test("reads the userinfo fields", () => {
    expect(parseProfile({ sub: "u1", email: "a@b.c", name: "Andy", role: "owner" })).toEqual({
      sub: "u1",
      email: "a@b.c",
      name: "Andy",
      role: "owner",
    })
  })

  test("defaults missing fields to empty strings", () => {
    expect(parseProfile(null)).toEqual({ sub: "", email: "", name: "", role: "" })
  })
})
