export interface PostgresService {
  name: string
  image: string
  containerName?: string
  port?: string
}

export function parseDockerCompose(text: string): PostgresService[] {
  const services: PostgresService[] = []
  const lines = text.split("\n")
  let current: PostgresService | undefined

  for (const line of lines) {
    if (/^[^\s]/.test(line)) {
      current = undefined
      continue
    }

    const serviceMatch = /^  ([\w-]+):\s*$/.exec(line)
    if (serviceMatch) {
      current = { name: serviceMatch[1] ?? "", image: "" }
      continue
    }

    if (!current) continue

    const imageMatch = /^\s+image:\s*(.+)\s*$/.exec(line)
    if (imageMatch) current.image = (imageMatch[1] ?? "").trim()

    const containerMatch = /^\s+container_name:\s*(.+)\s*$/.exec(line)
    if (containerMatch) current.containerName = (containerMatch[1] ?? "").trim()

    const portMatch = /^\s+- "(\d+):\d+"\s*$/.exec(line)
    if (portMatch) current.port = portMatch[1]

    if (current.image && isPostgresImage(current.image) && !services.includes(current)) services.push(current)
  }

  return services
}

function isPostgresImage(image: string): boolean {
  const lower = image.toLowerCase()
  return lower.includes("postgres") || lower.includes("pgvector") || lower.includes("postgis")
}

export interface DockerCommands {
  up: string[]
  down: string[]
  restart: string[]
  ps: string[]
}

export function postgresCommands(composePath: string, service: string): DockerCommands {
  const base = ["docker", "compose", "-f", composePath]
  return {
    up: [...base, "up", "-d", "--wait", service],
    down: [...base, "down"],
    restart: [...base, "restart", service],
    ps: [...base, "ps", service],
  }
}

export interface ComposeServiceStatus {
  service: string
  running: boolean
  health?: string
}

export function parseComposePs(output: string): ComposeServiceStatus[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      let row: { Service?: unknown; State?: unknown; Health?: unknown }
      try {
        row = JSON.parse(line) as { Service?: unknown; State?: unknown; Health?: unknown }
      } catch {
        return []
      }
      if (typeof row.Service !== "string") return []
      return [
        {
          service: row.Service,
          running: typeof row.State === "string" && row.State.toLowerCase() === "running",
          health: typeof row.Health === "string" ? row.Health : undefined,
        },
      ]
    })
}

export function postgresStatus(rows: ComposeServiceStatus[], service: string): "running" | "unhealthy" | "stopped" {
  const row = rows.find((item) => item.service === service)
  if (!row?.running) return "stopped"
  return row.health === "unhealthy" ? "unhealthy" : "running"
}
