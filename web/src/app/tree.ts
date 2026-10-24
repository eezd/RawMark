import { computed, reactive, ref, watch } from 'vue'
import type { Entry } from './api'
import { basename, dirname, hiddenAssetPath } from './paths'
import { rangePaths } from './selection'
import { ws } from './workspace'

export interface TreeNode {
  name: string
  path: string
  dir: boolean
  children: TreeNode[]
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function build(entries: Entry[]): TreeNode[] {
  const root: TreeNode[] = []
  const dirs = new Map<string, TreeNode>()
  // 先按路径排序，保证父目录先于子项出现
  for (const e of [...entries].sort((a, b) => a.path.length - b.path.length)) {
    const node: TreeNode = { name: basename(e.path), path: e.path, dir: e.dir, children: [] }
    if (e.dir) dirs.set(e.path, node)
    ;(dirs.get(dirname(e.path))?.children ?? root).push(node)
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)))
    nodes.forEach((n) => sort(n.children))
  }
  sort(root)
  return root
}

export const tree = computed(() => build(ws.entries.filter((entry) => !hiddenAssetPath(entry.path))))

// null 表示无接收目标，空字符串表示根目录；文件行指向它的直接父目录。
export const dropDirectory = ref<string | null>(null)

const EXPANDED_KEY = 'rawmark.expanded'
export const expanded = reactive(new Set<string>(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]))
watch(expanded, () => localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])))

// 打开或新建笔记时展开其所在的各级目录
watch(
  () => [ws.active, ws.renaming, ws.image],
  (paths) => {
    for (const p of paths) {
      for (let d = p ? dirname(p) : ''; d; d = dirname(d)) expanded.add(d)
    }
  },
)

export const selectedPaths = reactive(new Set<string>())
let anchor: string | null = null
export const visiblePaths = computed(() => {
  const paths: string[] = []
  const visit = (nodes: TreeNode[]) => { for (const node of nodes) { paths.push(node.path); if (expanded.has(node.path)) visit(node.children) } }
  visit(tree.value)
  return paths
})
watch(visiblePaths, (paths) => {
  const visible = new Set(paths)
  for (const path of selectedPaths) if (!visible.has(path)) selectedPaths.delete(path)
  if (anchor && !visible.has(anchor)) anchor = null
})

export function selectPath(path: string, event?: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) {
  const additive = event?.ctrlKey || event?.metaKey
  if (event?.shiftKey) {
    const range = rangePaths(visiblePaths.value, anchor, path)
    if (!additive) selectedPaths.clear()
    range.forEach((item) => selectedPaths.add(item))
    return
  }
  if (!additive) selectedPaths.clear()
  if (additive && selectedPaths.has(path)) selectedPaths.delete(path)
  else selectedPaths.add(path)
  anchor = path
}

export function contextSelection(path: string) {
  if (!selectedPaths.has(path)) selectPath(path)
}
