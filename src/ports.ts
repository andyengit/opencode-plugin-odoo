import { createServer } from "node:net"

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", (error: NodeJS.ErrnoException) => {
      // No IPv6 on this host: the family cannot be tested, so it does not count as taken.
      if (error.code === "EAFNOSUPPORT" || error.code === "EADDRNOTAVAIL") return resolve(true)
      resolve(false)
    })
    server.once("listening", () => server.close(() => resolve(true)))
    server.listen(port, host)
  })
}

async function isFree(port: number): Promise<boolean> {
  return (await canBind(port, "0.0.0.0")) && (await canBind(port, "::"))
}

export async function findFreePort(start: number): Promise<number> {
  let port = start
  while (!(await isFree(port))) port += 1
  return port
}

export async function findFreePorts(count: number, start: number): Promise<number[]> {
  const ports: number[] = []
  let next = start
  while (ports.length < count) {
    const port = await findFreePort(next)
    ports.push(port)
    next = port + 1
  }
  return ports
}
