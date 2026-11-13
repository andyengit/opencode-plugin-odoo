import { describe, expect, test } from "bun:test"
import { parseComposePs, parseDockerCompose, postgresCommands, postgresStatus } from "../src/docker"

const compose = `services:
  pgdb-18:
    image: pgvector/pgvector:pg17
    container_name: pgdb-18
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: odoo
      POSTGRES_PASSWORD: odoo
  web:
    image: nginx:latest
volumes:
  pgdb-data:
`

describe("parseDockerCompose", () => {
  test("finds postgres services", () => {
    const services = parseDockerCompose(compose)
    expect(services.map((service) => service.name)).toEqual(["pgdb-18"])
  })

  test("captures image, container name and port", () => {
    const [service] = parseDockerCompose(compose)
    expect(service?.image).toBe("pgvector/pgvector:pg17")
    expect(service?.containerName).toBe("pgdb-18")
    expect(service?.port).toBe("5432")
  })

  test("ignores non-postgres services", () => {
    const services = parseDockerCompose(compose)
    expect(services.some((service) => service.name === "web")).toBe(false)
  })
})

describe("postgresCommands", () => {
  test("builds compose commands with the service name", () => {
    const commands = postgresCommands("/path/docker-compose.yml", "pgdb-18")
    expect(commands.up).toEqual(["docker", "compose", "-f", "/path/docker-compose.yml", "up", "-d", "--wait", "pgdb-18"])
    expect(commands.down).toEqual(["docker", "compose", "-f", "/path/docker-compose.yml", "down"])
    expect(commands.restart).toEqual(["docker", "compose", "-f", "/path/docker-compose.yml", "restart", "pgdb-18"])
  })
})

describe("parseComposePs", () => {
  test("reads one JSON object per line", () => {
    const output =
      '{"Service":"pgdb-18","State":"running","Health":"healthy"}\n' +
      '{"Service":"other","State":"exited"}\n'
    const rows = parseComposePs(output)
    expect(rows).toEqual([
      { service: "pgdb-18", running: true, health: "healthy" },
      { service: "other", running: false, health: undefined },
    ])
  })

  test("ignores blank lines and non-JSON output", () => {
    expect(parseComposePs("\nnot json\n")).toEqual([])
  })
})

describe("postgresStatus", () => {
  test("reports running, unhealthy and stopped", () => {
    expect(postgresStatus([{ service: "pgdb", running: true, health: "healthy" }], "pgdb")).toBe("running")
    expect(postgresStatus([{ service: "pgdb", running: true, health: "unhealthy" }], "pgdb")).toBe("unhealthy")
    expect(postgresStatus([], "pgdb")).toBe("stopped")
  })
})
