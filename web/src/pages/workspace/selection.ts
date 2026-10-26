// Do not operate on descendants when their parent folder is already selected.
export function minimalPaths(paths: Iterable<string>): string[] {
  const out: string[] = []
  const roots = new Set<string>()
  for (const path of [...new Set(paths)].sort()) {
    let parent = path
    let covered = false
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'))
      if (roots.has(parent)) {
        covered = true; break
      }
    }
    if (!covered) {
      out.push(path); roots.add(path)
    }
  }
  return out
}

export function rangePaths(visible: string[], anchor: string | null, target: string): string[] {
  const from = anchor === null ? -1 : visible.indexOf(anchor)
  const to = visible.indexOf(target)
  return from < 0 || to < 0 ? [target] : visible.slice(Math.min(from, to), Math.max(from, to) + 1)
}
