// 工作区状态与操作：目录树、标签页、保存队列、冲突处理、实时同步。
// 文件操作一律先更新界面再请求服务器，失败时回滚，保证"操作即时生效"。
import { Annotation, Transaction, type EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { nextTick, reactive, watch } from 'vue'
import { createEditorState, pasteImages } from '../editor'
import { handleShortcut, registerCommand } from './commands'
import { api, ApiError, type Entry } from './api'
import { drafts } from './drafts'
import { connectEvents, type VaultEvent } from './events'
import { basename, dirname, joinPath, NOTE_EXT, resolveAssetUrl } from './paths'

export type TabStatus = 'loading' | 'ready' | 'conflict' | 'deleted' | 'error'

export interface Tab {
  path: string
  // 最近一次与服务器一致的版本
  rev: string
  status: TabStatus
  // 有尚未保存成功的修改
  dirty: boolean
  saveError?: string
  // 冲突时服务器上的版本；为空字符串表示服务器上已不存在
  conflictRev?: string
}

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

const RECENT_KEY = 'rawmark.recent'
const RECENT_MAX = 30

export const ws = reactive({
  entries: [] as Entry[],
  tabs: [] as Tab[],
  active: null as string | null,
  // 目录树中正在行内重命名的路径
  renaming: null as string | null,
  // 移动端侧栏抽屉
  sidebarOpen: false,
  // 侧栏显示搜索而非目录树
  searchOpen: false,
  // 快速切换/命令面板的初始输入，null 为关闭；以 > 开头时列出命令
  switcher: null as string | null,
  trashOpen: false,
  // 最近打开的笔记，最新的在前
  recent: JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[],
  toasts: [] as Toast[],
})

const SAVE_DELAY = 500
const RETRY_DELAY = 5000
const MAX_RETRIES = 12

// 以下状态不放进 reactive：EditorState 体积大且不可变，交给 Vue 代理没有意义
const editorStates = new Map<string, EditorState>()
// 每个打开的笔记一个可变引用，编辑器扩展通过它取得笔记的当前路径（重命名后随之更新）
const noteRefs = new Map<string, { path: string }>()

interface SaveSlot {
  timer?: ReturnType<typeof setTimeout>
  inflight?: Promise<void>
  // 修改序号与已保存序号，二者相等即没有待保存的修改
  seq: number
  savedSeq: number
  uploads: number
  paused: number
  retries: number
}
const slots = new Map<string, SaveSlot>()

let view: EditorView | null = null
// 进行中的本地文件操作数；期间收到的目录事件不用于判断标签页是否被删除
let opsInFlight = 0

const externalChange = Annotation.define<boolean>()

export function tabOf(path: string | null): Tab | undefined {
  return path === null ? undefined : ws.tabs.find((t) => t.path === path)
}

export function activeTab(): Tab | undefined {
  return tabOf(ws.active)
}

// ---- 提示 ----

let toastId = 0
export function toast(text: string, action?: Toast['action']) {
  const t: Toast = { id: ++toastId, text, action }
  ws.toasts.push(t)
  setTimeout(() => dismissToast(t.id), action ? 6000 : 3500)
}

export function dismissToast(id: number) {
  const i = ws.toasts.findIndex((t) => t.id === id)
  if (i >= 0) ws.toasts.splice(i, 1)
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : '网络错误，请检查连接'
}

// ---- 编辑器状态 ----

export function attachView(v: EditorView | null) {
  view = v
}

export function editorStateOf(path: string): EditorState | undefined {
  return editorStates.get(path)
}

// 笔记的身份对象：重命名/移动后保持不变，用于判断编辑器中显示的是否仍是同一篇笔记
export function noteRefOf(path: string): { path: string } | undefined {
  return noteRefs.get(path)
}

// 切换标签页前由编辑器面板调用，保存当前视图状态（含光标、滚动无关的选区与撤销历史）
export function storeViewState(path: string, state: EditorState) {
  if (editorStates.has(path)) editorStates.set(path, state)
}

function buildState(path: string, doc: string): EditorState {
  const ref = { path }
  noteRefs.set(path, ref)
  return createEditorState({
    doc,
    resolveImage: (src) => resolveAssetUrl(ref.path, src),
    onChange: (u) => {
      editorStates.set(ref.path, u.state)
      if (!u.transactions.some((tr) => tr.annotation(externalChange))) scheduleSave(ref.path)
    },
    extensions: [
      pasteImages({
        upload: (file) => api.upload(ref.path, file),
        onError: (err) => toast('图片上传失败：' + errorText(err)),
        onPending: (d) => {
          slot(ref.path).uploads += d
        },
      }),
    ],
  })
}

// 用服务器内容替换文档：只替换首尾相同部分之间的差异，尽量保留光标位置；不进入撤销历史
function replaceDoc(path: string, content: string) {
  const state = path === ws.active && view ? view.state : editorStates.get(path)
  if (!state) return
  const old = state.doc.toString()
  if (old === content) return
  let start = 0
  while (start < old.length && start < content.length && old[start] === content[start]) start++
  let endOld = old.length
  let endNew = content.length
  while (endOld > start && endNew > start && old[endOld - 1] === content[endNew - 1]) {
    endOld--
    endNew--
  }
  const spec = {
    changes: { from: start, to: endOld, insert: content.slice(start, endNew) },
    annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
  }
  if (path === ws.active && view) view.dispatch(spec)
  else editorStates.set(path, state.update(spec).state)
}

function docOf(path: string): string | undefined {
  if (path === ws.active && view && editorStates.has(path)) return view.state.doc.toString()
  return editorStates.get(path)?.doc.toString()
}

// ---- 保存队列 ----

function slot(path: string): SaveSlot {
  let s = slots.get(path)
  if (!s) slots.set(path, (s = { seq: 0, savedSeq: 0, uploads: 0, paused: 0, retries: 0 }))
  return s
}

function scheduleSave(path: string, delay = SAVE_DELAY) {
  const s = slot(path)
  s.seq++
  const tab = tabOf(path)
  if (tab) tab.dirty = true
  clearTimeout(s.timer)
  s.timer = setTimeout(() => void flush(path), delay)
}

// 立即保存一篇笔记的待保存修改；keepalive 用于页面隐藏/关闭时尽力发出请求
export async function flush(path: string, keepalive = false): Promise<void> {
  const s = slots.get(path)
  if (!s) return
  clearTimeout(s.timer)
  while (s.inflight) await s.inflight
  const tab = tabOf(path)
  if (!tab || tab.status !== 'ready' || s.seq === s.savedSeq) return
  if (s.paused || s.uploads) {
    // 图片上传中或文件正在移动，稍后再存，避免写入临时 blob: 地址或写到旧路径
    s.timer = setTimeout(() => void flush(path), SAVE_DELAY)
    return
  }
  const content = docOf(path)
  if (content === undefined) return
  const seq = s.seq
  const baseRev = tab.rev
  s.inflight = (async () => {
    // 草稿与请求并行：页面关闭时等待 IndexedDB 写完再发请求，请求往往来不及发出
    // 草稿只是兜底，写入失败不影响保存本身
    const draftSaved = drafts.put({ path, content, baseRev, updatedAt: Date.now() }).catch((err) => console.warn('写入本地草稿失败', err))
    try {
      const rev = await api.writeFile(path, content, baseRev, keepalive)
      await draftSaved
      tab.rev = rev
      tab.saveError = undefined
      s.savedSeq = seq
      s.retries = 0
      if (s.seq === seq) {
        tab.dirty = false
        await drafts.delete(path)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        const serverRev = typeof err.data.rev === 'string' ? err.data.rev : ''
        tab.status = serverRev ? 'conflict' : 'deleted'
        tab.conflictRev = serverRev
      } else if (!(err instanceof ApiError) || err.status >= 500) {
        // 网络错误与服务器错误可重试，草稿已在本地，不会丢
        tab.saveError = s.retries < MAX_RETRIES ? '保存失败，正在重试…' : '保存失败，请检查网络后重试'
        if (s.retries++ < MAX_RETRIES) s.timer = setTimeout(() => void flush(path), RETRY_DELAY)
      } else {
        tab.saveError = '保存失败：' + err.message
      }
    }
  })()
  await s.inflight
  s.inflight = undefined
  if (s.seq !== s.savedSeq && tab.status === 'ready' && !s.timer) scheduleSave(path)
}

export function retrySave(path: string) {
  slot(path).retries = 0
  void flush(path)
}

export async function flushAll(keepalive = false) {
  await Promise.all([...slots.keys()].map((p) => flush(p, keepalive)))
}

// ---- 冲突处理 ----

// 放弃本地修改，载入服务器版本
export async function useServerVersion(path: string) {
  const tab = tabOf(path)
  if (!tab) return
  try {
    const { content, rev } = await api.readFile(path)
    replaceDoc(path, content)
    const s = slot(path)
    s.savedSeq = s.seq
    Object.assign(tab, { rev, status: 'ready', dirty: false, conflictRev: undefined, saveError: undefined })
    await drafts.delete(path)
  } catch (err) {
    toast('载入失败：' + errorText(err))
  }
}

// 保留本地修改，覆盖服务器版本（服务器上已删除时重新创建）
export async function keepLocalVersion(path: string) {
  const tab = tabOf(path)
  const content = docOf(path)
  if (!tab || content === undefined) return
  try {
    const rev = await api.writeFile(path, content, tab.conflictRev ?? '')
    const s = slot(path)
    s.savedSeq = s.seq
    Object.assign(tab, { rev, status: 'ready', dirty: false, conflictRev: undefined, saveError: undefined })
    await drafts.delete(path)
    if (!ws.entries.some((e) => e.path === path)) void refreshTree()
  } catch (err) {
    if (err instanceof ApiError && err.status === 412) {
      tab.conflictRev = typeof err.data.rev === 'string' ? err.data.rev : ''
      toast('服务器上的版本又变化了，请再次选择')
    } else toast('保存失败：' + errorText(err))
  }
}

// ---- 打开并聚焦（快速切换、搜索结果跳转） ----

interface RevealTarget {
  path: string
  line: number
  terms: string[]
}
// 笔记可能尚未载入或编辑器尚未显示，由编辑器面板在显示该笔记后执行
let pendingReveal: RevealTarget | null = null

/** 打开笔记并聚焦编辑器；line > 0 时定位到该行（从 1 开始）并选中该行第一个搜索词 */
export async function openAt(path: string, line = 0, terms: string[] = []) {
  pendingReveal = { path, line, terms }
  if (path === ws.active && view && editorStates.has(path)) {
    ws.sidebarOpen = false
    revealPending(view, path)
  } else await openNote(path)
}

/** 编辑器面板显示笔记后调用；返回 true 表示已定位到指定行（不应再恢复原来的滚动位置） */
export function revealPending(v: EditorView, path: string): boolean {
  const r = pendingReveal
  if (!r || r.path !== path) return false
  pendingReveal = null
  // 触屏设备上聚焦会弹出软键盘遮住内容，只在有鼠标的设备上聚焦
  if (!matchMedia('(pointer: coarse)').matches) v.focus()
  if (r.line === 0) return false
  const line = v.state.doc.line(Math.min(r.line, v.state.doc.lines))
  const text = line.text.toLowerCase()
  let at = -1
  let len = 0
  for (const t of r.terms) {
    const i = text.indexOf(t.toLowerCase())
    if (i >= 0 && (at < 0 || i < at)) [at, len] = [i, t.length]
  }
  const from = line.from + Math.max(at, 0)
  v.dispatch({ selection: { anchor: from, head: from + len }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
  return true
}

// ---- 标签页 ----

export async function openNote(path: string) {
  ws.sidebarOpen = false
  if (tabOf(path)) {
    ws.active = path
    return
  }
  const tab: Tab = { path, rev: '', status: 'loading', dirty: false }
  ws.tabs.push(tab)
  ws.active = path
  try {
    const { content, rev } = await api.readFile(path)
    editorStates.set(path, buildState(path, content))
    const t = tabOf(path)
    if (t) Object.assign(t, { rev, status: 'ready' })
  } catch (err) {
    const t = tabOf(path)
    if (t) t.status = 'error'
    toast('打开失败：' + errorText(err))
  }
}

export async function closeTab(path: string) {
  await flush(path)
  const i = ws.tabs.findIndex((t) => t.path === path)
  if (i < 0) return
  const tab = ws.tabs[i]
  if (tab.dirty && tab.status !== 'ready') {
    // 冲突或已删除且有未保存修改：草稿保留在本地，下次打开时可恢复
    toast('未保存的修改已保留为本地草稿')
  }
  ws.tabs.splice(i, 1)
  forget(path)
  if (ws.active === path) ws.active = ws.tabs[Math.min(i, ws.tabs.length - 1)]?.path ?? null
}

function forget(path: string) {
  editorStates.delete(path)
  noteRefs.delete(path)
  const s = slots.get(path)
  if (s) clearTimeout(s.timer)
  slots.delete(path)
}

// 路径前缀替换（移动文件夹时其下所有路径一起变化）
function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to
  if (p.startsWith(from + '/')) return to + p.slice(from.length)
  return null
}

function remapOpenNotes(from: string, to: string) {
  for (const tab of ws.tabs) {
    const next = remapPath(tab.path, from, to)
    if (next === null) continue
    const old = tab.path
    tab.path = next
    if (ws.active === old) ws.active = next
    for (const map of [editorStates, noteRefs, slots] as Map<string, unknown>[]) {
      if (map.has(old)) {
        map.set(next, map.get(old))
        map.delete(old)
      }
    }
    const ref = noteRefs.get(next)
    if (ref) ref.path = next
  }
}

function remapRecent(from: string, to: string) {
  ws.recent = ws.recent.map((p) => remapPath(p, from, to) ?? p)
}

function affected(path: string): string[] {
  return ws.tabs.map((t) => t.path).filter((p) => p === path || p.startsWith(path + '/'))
}

// ---- 目录树 ----

// 目录刷新：同一时间只有一个请求；请求期间又有刷新请求或本地操作时，结果可能已过时，丢弃后重新获取。
// 本地操作会先乐观修改目录，过时的结果会抹掉刚加入的条目（例如新建笔记的重命名框随之消失）。
// 等待中的调用者在下一次被采用的结果（或请求失败）后统一完成
let treeTimer: ReturnType<typeof setTimeout> | undefined
let treeFetching = false
let treeAgain = false
let localTreeEdits = 0
const treeWaiters: (() => void)[] = []

export function refreshTree(): Promise<void> {
  return new Promise((resolve) => {
    treeWaiters.push(resolve)
    scheduleTreeRefresh()
  })
}

function scheduleTreeRefresh() {
  if (treeFetching) {
    treeAgain = true
    return
  }
  clearTimeout(treeTimer)
  treeTimer = setTimeout(() => void fetchTree(), 50)
}

async function fetchTree() {
  treeFetching = true
  treeAgain = false
  const edits = localTreeEdits
  let entries: Entry[] | null = null
  try {
    entries = await api.tree()
  } catch (err) {
    toast('刷新目录失败：' + errorText(err))
  }
  treeFetching = false
  if (entries && (treeAgain || edits !== localTreeEdits || opsInFlight > 0)) {
    // 有操作进行中时由 withOp 在全部结束后重新调度
    if (opsInFlight === 0) scheduleTreeRefresh()
    return
  }
  if (entries) {
    ws.entries = entries
    markMissingTabsDeleted()
  }
  for (const resolve of treeWaiters.splice(0)) resolve()
}

function markMissingTabsDeleted() {
  const exists = new Set(ws.entries.map((e) => e.path))
  for (const tab of ws.tabs) {
    if (tab.status === 'ready' && !exists.has(tab.path)) {
      tab.status = 'deleted'
      tab.conflictRev = ''
    }
  }
}

function uniqueName(dir: string, base: string, ext: string): string {
  const taken = new Set(ws.entries.map((e) => e.path))
  for (let i = 0; ; i++) {
    const name = base + (i ? ` ${i}` : '') + ext
    if (!taken.has(joinPath(dir, name))) return joinPath(dir, name)
  }
}

async function withOp<T>(fn: () => Promise<T>): Promise<T> {
  opsInFlight++
  localTreeEdits++
  try {
    return await fn()
  } finally {
    localTreeEdits++
    if (--opsInFlight === 0 && treeWaiters.length) scheduleTreeRefresh()
  }
}

export async function createNote(dir: string) {
  const path = uniqueName(dir, '未命名', NOTE_EXT)
  ws.renaming = path
  await createNoteAt(path)
}

// 进行中的新建：新建后立即出现重命名输入框，重命名须等文件真正创建后再执行
const creating = new Map<string, Promise<boolean>>()

/** 在指定路径新建空笔记并打开，返回是否成功；不存在的上级目录由服务器创建 */
export async function createNoteAt(path: string): Promise<boolean> {
  const done = createNoteFile(path)
  creating.set(path, done)
  try {
    return await done
  } finally {
    creating.delete(path)
  }
}

async function createNoteFile(path: string): Promise<boolean> {
  const exists = new Set(ws.entries.map((e) => e.path))
  const added = [path]
  for (let d = dirname(path); d && !exists.has(d); d = dirname(d)) added.push(d)
  ws.entries.push(...added.map((p, i) => ({ path: p, dir: i > 0, size: 0, mtime: Date.now() })))
  return withOp(async () => {
    try {
      const rev = await api.writeFile(path, '', '')
      ws.tabs.push({ path, rev, status: 'ready', dirty: false })
      editorStates.set(path, buildState(path, ''))
      ws.active = path
      return true
    } catch (err) {
      ws.entries = ws.entries.filter((e) => !added.includes(e.path))
      if (ws.renaming === path) ws.renaming = null
      toast('新建笔记失败：' + errorText(err))
      return false
    }
  })
}

export async function createFolder(dir: string) {
  const path = uniqueName(dir, '新建文件夹', '')
  ws.entries.push({ path, dir: true, size: 0, mtime: Date.now() })
  ws.renaming = path
  await withOp(async () => {
    try {
      await api.mkdir(path)
    } catch (err) {
      ws.entries = ws.entries.filter((e) => e.path !== path)
      if (ws.renaming === path) ws.renaming = null
      toast('新建文件夹失败：' + errorText(err))
    }
  })
}

export function renameTarget(path: string, name: string): string | null {
  name = name.trim().replace(/\//g, '')
  if (!name || name.startsWith('.')) return null
  const entry = ws.entries.find((e) => e.path === path)
  if (entry && !entry.dir && !name.endsWith(NOTE_EXT)) name += NOTE_EXT
  return joinPath(dirname(path), name)
}

export async function move(from: string, to: string) {
  if (from === to) return
  if (creating.has(from) && !(await creating.get(from))) return
  if (ws.entries.some((e) => e.path === to)) {
    toast(`“${basename(to)}”已存在`)
    return
  }
  await withOp(async () => {
    // 先保存待保存的修改，确保移动的是最新内容；移动期间暂停保存，避免写到旧路径
    await Promise.all(affected(from).map((p) => flush(p)))
    const paused = affected(from).map(slot)
    paused.forEach((s) => s.paused++)
    const snapshot = ws.entries
    ws.entries = ws.entries.map((e) => ({ ...e, path: remapPath(e.path, from, to) ?? e.path }))
    remapOpenNotes(from, to)
    remapRecent(from, to)
    try {
      await api.move(from, to)
    } catch (err) {
      ws.entries = snapshot
      remapOpenNotes(to, from)
      remapRecent(to, from)
      toast('移动失败：' + errorText(err))
      return
    } finally {
      paused.forEach((s) => s.paused--)
    }
    // 笔记改名时服务器会改写正文中的图片链接，版本随之变化，需要重新同步
    await Promise.all(affected(to).map(async (p) => {
      const tab = tabOf(p)
      if (!tab) return
      if (tab.dirty) {
        // 移动期间又有输入：本地内容仍含旧链接，交给用户选择
        const { rev } = await api.readFile(p)
        if (rev !== tab.rev) Object.assign(tab, { status: 'conflict', conflictRev: rev })
      } else await syncOpenTab(tab)
    }))
  })
  void refreshTree()
}

export async function remove(path: string) {
  const entry = ws.entries.find((e) => e.path === path)
  if (!entry) return
  await withOp(async () => {
    const paths = affected(path)
    await Promise.all(paths.map((p) => flush(p)))
    const snapshot = ws.entries
    ws.entries = ws.entries.filter((e) => remapPath(e.path, path, path) === null) // 去掉自身及其下所有条目
    for (const p of paths) await closeTab(p)
    try {
      const item = await api.deleteFile(path)
      toast(`已删除“${basename(path).replace(/\.md$/, '')}”`, {
        label: '撤销',
        run: () => void restore(item.id),
      })
    } catch (err) {
      ws.entries = snapshot
      toast('删除失败：' + errorText(err))
    }
  })
}

export async function restore(id: string) {
  try {
    const item = await api.restore(id)
    await refreshTree()
    if (!item.dir) void openNote(item.path)
  } catch (err) {
    toast('恢复失败：' + errorText(err))
  }
}

// ---- 实时同步 ----

async function syncOpenTab(tab: Tab) {
  const s = slots.get(tab.path)
  if (tab.status !== 'ready' || tab.dirty || s?.inflight) return
  try {
    const { content, rev } = await api.readFile(tab.path)
    if (rev === tab.rev || tab.dirty) return
    replaceDoc(tab.path, content)
    tab.rev = rev
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      tab.status = 'deleted'
      tab.conflictRev = ''
    }
  }
}

function handleEvents(evs: VaultEvent[]) {
  for (const ev of evs) {
    if (ev.type === 'tree') void refreshTree()
    else if (ev.type === 'changed') {
      const tab = tabOf(ev.path!)
      // 自己保存产生的事件 rev 与本地一致；有本地修改时不覆盖，交由下次保存的冲突检测处理
      if (tab && tab.rev !== ev.rev) void syncOpenTab(tab)
    } else if (ev.type === 'moved') {
      if (tabOf(ev.from!) && !tabOf(ev.path!)) remapOpenNotes(ev.from!, ev.path!)
      remapRecent(ev.from!, ev.path!)
    } else if (ev.type === 'deleted') {
      const tab = tabOf(ev.path!)
      if (tab && tab.status === 'ready' && opsInFlight === 0) {
        tab.status = 'deleted'
        tab.conflictRev = ''
      }
    }
  }
}

async function resync() {
  await refreshTree()
  await Promise.all(ws.tabs.map(syncOpenTab))
}

// ---- 启动 ----

const TABS_KEY = 'rawmark.tabs'

// 恢复未保存成功的草稿：服务器版本未变则继续保存，已变则进入冲突状态由用户选择
async function recoverDrafts() {
  for (const d of await drafts.all()) {
    try {
      const { content, rev } = await api.readFile(d.path)
      if (content === d.content) {
        await drafts.delete(d.path)
        continue
      }
      if (!tabOf(d.path)) ws.tabs.push({ path: d.path, rev, status: 'ready', dirty: false })
      const tab = tabOf(d.path)!
      editorStates.set(d.path, buildState(d.path, d.content))
      tab.rev = rev
      if (rev === d.baseRev) {
        tab.status = 'ready'
        scheduleSave(d.path)
      } else Object.assign(tab, { status: 'conflict', conflictRev: rev, dirty: true })
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 404) throw err
      ws.tabs.push({ path: d.path, rev: '', status: 'deleted', dirty: true, conflictRev: '' })
      editorStates.set(d.path, buildState(d.path, d.content))
    }
  }
}

let disconnect: (() => void) | undefined
let listenersInstalled = false

export async function startWorkspace() {
  await refreshTree()
  const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{"paths":[],"active":null}') as { paths: string[]; active: string | null }
  const exists = new Set(ws.entries.map((e) => e.path))
  await Promise.all(saved.paths.filter((p) => exists.has(p)).map(openNote))
  try {
    await recoverDrafts()
  } catch (err) {
    toast('恢复本地草稿失败：' + errorText(err))
  }
  ws.active = saved.active && tabOf(saved.active) ? saved.active : (ws.tabs[0]?.path ?? null)
  disconnect = connectEvents({ onEvents: handleEvents, onResync: () => void resync() })
  // 重新登录后工作区会再次启动，以下全局监听只注册一次
  if (listenersInstalled) return
  listenersInstalled = true
  watch(
    () => [ws.tabs.map((t) => t.path), ws.active] as const,
    ([paths, active]) => localStorage.setItem(TABS_KEY, JSON.stringify({ paths, active })),
    // 启动期间（如等待目录刷新时）打开的标签页也要立即记录
    { immediate: true },
  )
  watch(
    () => ws.active,
    (p) => {
      if (p) ws.recent = [p, ...ws.recent.filter((r) => r !== p)].slice(0, RECENT_MAX)
    },
    { immediate: true },
  )
  watch(
    () => ws.recent,
    (r) => localStorage.setItem(RECENT_KEY, JSON.stringify(r)),
  )
  // 页面隐藏/关闭前尽力发出待保存的修改（部分浏览器关闭标签页时只触发 pagehide）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAll(true)
  })
  window.addEventListener('pagehide', () => void flushAll(true))
  window.addEventListener('keydown', handleShortcut)
}

// 内置命令不依赖工作区状态，模块载入时注册，排在组件注册的命令（如退出登录）之前
registerBuiltinCommands()

function registerBuiltinCommands() {
  const hasNote = () => ws.active !== null
  const toggleSwitcher = (initial: string) => {
    ws.switcher = ws.switcher === null ? initial : null
  }
  for (const cmd of [
    // Mod+P 覆盖浏览器的打印；Firefox 不允许网页覆盖 Ctrl+Shift+P（隐私窗口），F1 作为通用的替代
    { id: 'app.quickOpen', title: '快速打开笔记', keys: ['Mod+P'], run: () => toggleSwitcher('') },
    { id: 'app.commandPalette', title: '命令面板', keys: ['Mod+Shift+P', 'F1'], run: () => toggleSwitcher('>') },
    { id: 'app.search', title: '全文搜索', keys: ['Mod+Shift+F'], run: openSearch },
    { id: 'note.new', title: '新建笔记', run: () => withSidebar(() => createNote('')) },
    { id: 'folder.new', title: '新建文件夹', run: () => withSidebar(() => createFolder('')) },
    { id: 'note.save', title: '保存当前笔记', keys: ['Mod+S'], when: hasNote, run: () => void flush(ws.active!) },
    { id: 'note.rename', title: '重命名当前笔记', when: hasNote, run: () => withSidebar(() => (ws.renaming = ws.active)) },
    { id: 'note.delete', title: '删除当前笔记', when: hasNote, run: () => void remove(ws.active!) },
    // 浏览器不允许网页覆盖 Ctrl+W
    { id: 'tab.close', title: '关闭当前标签页', when: hasNote, run: () => void closeTab(ws.active!) },
    { id: 'app.trash', title: '打开回收站', run: () => (ws.trashOpen = true) },
  ]) {
    registerCommand(cmd)
  }
}

// 需要在目录树中操作的命令：切回目录树，移动端打开侧栏
function withSidebar(fn: () => unknown) {
  ws.searchOpen = false
  ws.sidebarOpen = true
  void fn()
}

export function openSearch() {
  ws.searchOpen = true
  ws.sidebarOpen = true
  // 已打开时重新聚焦并全选，便于直接输入新的搜索词
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.rm-search-input')
    input?.focus()
    input?.select()
  })
}

export function stopWorkspace() {
  disconnect?.()
  disconnect = undefined
}
