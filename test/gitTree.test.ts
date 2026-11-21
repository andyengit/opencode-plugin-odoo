import { describe, expect, test } from "bun:test"
import { buildFileTree, folderFiles } from "../src/gitTree"

describe("buildFileTree", () => {
  test("groups paths by folder and keeps root files", () => {
    const tree = buildFileTree([
      { path: "b.txt" },
      { path: "models/a.py" },
      { path: "views/b.xml" },
      { path: "models/sub/c.py" },
    ])
    expect(tree.files.map((file) => file.path)).toEqual(["b.txt"])
    expect(tree.folders.map((folder) => folder.name)).toEqual(["models", "views"])
    const models = tree.folders[0]
    expect(models?.files.map((file) => file.path)).toEqual(["models/a.py"])
    expect(models?.folders[0]?.name).toBe("sub")
    expect(models?.folders[0]?.files[0]?.path).toBe("models/sub/c.py")
  })

  test("collects every nested file of a folder", () => {
    const tree = buildFileTree([
      { path: "models/a.py" },
      { path: "models/sub/c.py" },
      { path: "views/b.xml" },
    ])
    expect(folderFiles(tree.folders[0]!).map((file) => file.path)).toEqual(["models/a.py", "models/sub/c.py"])
  })

  test("returns an empty root for no files", () => {
    expect(buildFileTree([])).toEqual({ name: "", path: "", folders: [], files: [] })
  })
})
