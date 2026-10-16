import { computed, reactive, watch } from 'vue'
import type { Entry } from './api'
import { basename, dirname } from './paths'
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

export const tree = computed(() => build(ws.entries))

const EXPANDED_KEY = 'rawmark.expanded'
export const expanded = reactive(new Set<string>(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '[]') as string[]))
watch(expanded, () => localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])))

// 打开或新建笔记时展开其所在的各级目录
watch(
  () => [ws.active, ws.renaming],
  (paths) => {
    for (const p of paths) {
      for (let d = p ? dirname(p) : ''; d; d = dirname(d)) expanded.add(d)
    }
  },
)
