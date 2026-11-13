import { describe, expect, test } from "bun:test"
import { missingRequirements, packageName, parseRequirements } from "../src/requirements"

describe("packageName", () => {
  test("reads a plain name and a version specifier", () => {
    expect(packageName("pandas")).toBe("pandas")
    expect(packageName("pandas==2.0.3")).toBe("pandas")
    expect(packageName("openpyxl>=3,<4")).toBe("openpyxl")
  })

  test("normalizes the name and drops extras and markers", () => {
    expect(packageName("python_dateutil[fast]>=2.8; python_version>'3.8'")).toBe("python-dateutil")
    expect(packageName("Zope.Interface")).toBe("zope-interface")
  })

  test("ignores comments, options and bare URLs", () => {
    expect(packageName("# pandas")).toBeUndefined()
    expect(packageName("-r other.txt")).toBeUndefined()
    expect(packageName("git+https://github.com/OCA/web.git")).toBeUndefined()
    expect(packageName("")).toBeUndefined()
  })
})

describe("parseRequirements", () => {
  test("collects unique package names", () => {
    const text = `# OCA deps\npandas>=2\nxlrd\npython_dateutil\npandas\n`
    expect(parseRequirements(text)).toEqual(["pandas", "xlrd", "python-dateutil"])
  })

  test("returns nothing for an empty file", () => {
    expect(parseRequirements("")).toEqual([])
  })
})

describe("missingRequirements", () => {
  test("compares normalized names", () => {
    expect(missingRequirements(["python-dateutil", "pandas"], ["pandas", "Python_Dateutil"])).toEqual([])
  })

  test("keeps the requirements order for missing packages", () => {
    expect(missingRequirements(["xlrd", "pandas", "openpyxl"], ["pandas"])).toEqual(["xlrd", "openpyxl"])
  })
})
