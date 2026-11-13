import { describe, expect, test } from "bun:test"
import { runProcess } from "../src/execute"

const cwd = process.cwd()

describe("runProcess", () => {
  test("captures stdout and the exit code", async () => {
    const result = await runProcess(process.execPath, ["-e", "console.log('hello')"], { cwd })
    expect(result.code).toBe(0)
    expect(result.output.trim()).toBe("hello")
  })

  test("reports a non-zero exit", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.exit(3)"], { cwd })
    expect(result.code).toBe(3)
  })

  test("feeds stdin to the command", async () => {
    const result = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd,
      input: "piped input",
    })
    expect(result.output).toContain("piped input")
  })
})
