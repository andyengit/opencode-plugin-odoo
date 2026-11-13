/** The package name of a requirement line, normalized the PEP 503 way, or nothing when it is not one. */
export function packageName(requirement: string): string | undefined {
  const line = requirement.trim()
  if (line === "" || line.startsWith("#") || line.startsWith("-")) return
  if (line.includes("://") || line.startsWith("git+") || line.startsWith(".") || line.startsWith("/")) return
  const bare = line.split(";")[0]?.split("[")[0] ?? ""
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(bare.trim())
  return match?.[1]?.toLowerCase().replace(/[-_.]+/g, "-")
}

/** The package names a requirements file lists, deduplicated. */
export function parseRequirements(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split("\n")) {
    const name = packageName(line)
    if (name) names.add(name)
  }
  return [...names]
}

/** Requirement names not installed, keeping the order of the requirements file. */
export function missingRequirements(required: string[], installed: string[]): string[] {
  const present = new Set(installed.map((name) => name.toLowerCase().replace(/[-_.]+/g, "-")))
  return required.filter((name) => !present.has(name.toLowerCase().replace(/[-_.]+/g, "-")))
}
