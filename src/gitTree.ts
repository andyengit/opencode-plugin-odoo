/** Folder tree for the Git panel's file lists. */

export interface TreeFile {
  path: string
}

export interface FolderNode<T extends TreeFile = TreeFile> {
  name: string
  path: string
  folders: FolderNode<T>[]
  files: T[]
}

/** Groups repository paths into a folder tree, sorted folder by folder. */
export function buildFileTree<T extends TreeFile>(files: T[]): FolderNode<T> {
  const root: FolderNode<T> = { name: "", path: "", folders: [], files: [] }
  for (const file of files) {
    const parts = file.path.split("/")
    let node = root
    for (let index = 0; index < parts.length - 1; index++) {
      const name = parts[index] ?? ""
      const path = parts.slice(0, index + 1).join("/")
      let child = node.folders.find((entry) => entry.path === path)
      if (!child) {
        child = { name, path, folders: [], files: [] }
        node.folders.push(child)
      }
      node = child
    }
    node.files.push(file)
  }
  const sort = (node: FolderNode<T>) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.path.localeCompare(b.path))
    for (const child of node.folders) sort(child)
  }
  sort(root)
  return root
}

/** Every file under a folder, including its subfolders. */
export function folderFiles<T extends TreeFile>(node: FolderNode<T>): T[] {
  return [...node.files, ...node.folders.flatMap((folder) => folderFiles(folder))]
}
