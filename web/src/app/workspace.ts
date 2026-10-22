// 工作区状态与操作：目录树、标签页、保存队列、冲突处理、实时同步。
// 文件操作一律先更新界面再请求服务器，失败时回滚，保证"操作即时生效"。
import { Annotation, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { nextTick, reactive, watch } from 'vue'
import { editorCommands } from '../editor/shortcuts'
import { refreshImages } from '../editor/livepreview'
import { createEditorState, insertImageFiles, pasteImages, languageCompartment, pluginCompartment, pluginEditorExtensions, pluginLanguage, preferencesCompartment, previewCompartment, previewExtensions } from '../editor'
import { handleShortcut, registerCommand } from './commands'
import { api, ApiError, encodePath, type Entry } from './api'
import { drafts } from './drafts'
import { refreshMetadata } from './metadata'
import { connectEvents, type VaultEvent } from './events'
import { basename, dirname, joinPath, isImage, NOTE_EXT, resolveAssetUrl } from './paths'
import { loadSettings, settings } from './settings'
import { trackVisualViewport } from './viewport'
import { appearancePaused } from '../themes/appearance'
import { notePath, pluginEvents, pluginRefresh, pluginsPaused, setPluginEditorHandlers } from '../plugins/registry'
import { pluginEditorFailure, refreshPlugins, startPlugins, stopPlugins } from '../plugins/host'
import type { PluginAPI } from '../plugin-api'

export type TabStatus = 'loading' | 'ready' | 'conflict' | 'deleted' | 'error'

export interface Tab {
  path: string
  pinned?: boolean
  // 最近一次与服务器一致的版本
  rev: string
  status: TabStatus
  // 有尚未保存成功的修改
  dirty: boolean
  saveError?: string
  // 冲突时服务器上的版本；为空字符串表示服务器上已不存在
  conflictRev?: string
}

export type SettingsSection = 'appearance' | 'editor' | 'account' | 'shortcuts' | 'shares' | 'tokens' | 'trash' | 'plugins' | 'about'

export interface Toast {
  id: number
  text: string
  action?: { label: string; run: () => void }
}

const RECENT_KEY = 'rawmark.recent'
// 本机的界面状态（不属于设置）：侧栏折叠、大纲面板
const LAYOUT_KEY = 'rawmark.layout'
const layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as { sidebarCollapsed?: boolean; outlineOpen?: boolean }
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
  // 打开的设置分组，null 为关闭；index 为从通用入口打开（手机上先显示分组列表，电脑上显示第一组）
  settings: (pluginsPaused ? 'plugins' : appearancePaused ? 'appearance' : null) as SettingsSection | 'index' | null,
  // 分享当前笔记的对话框（笔记路径）
  sharing: null as string | string[] | null,
  // 「移动到…」对话框（笔记或文件夹路径）
  moving: null as string | string[] | null,
  // 导入目标目录，空字符串为根目录
  importing: null as string | null,
  // 图片预览与管理，独立于笔记标签和草稿
  image: null as string | null,
  images: null as string | null,
  // 电脑上侧栏折叠
  sidebarCollapsed: layout.sidebarCollapsed ?? false,
  // 大纲面板（电脑上在右侧常驻，手机上为浮层）
  outlineOpen: layout.outlineOpen ?? false,
  sourceMode: false,
  focusMode: false,
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

// 编辑器内容或光标变化的订阅者（大纲面板）；不经过 Vue 响应式，避免每次按键都触发组件更新
const editorListeners = new Set<() => void>()
export function onEditorUpdate(fn: () => void): () => void {
  editorListeners.add(fn)
  return () => editorListeners.delete(fn)
}

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

/** 当前显示的编辑器视图（手机工具条等需要直接操作编辑器） */
export function editorView(): EditorView | null {
  return view
}

export function toggleSourceMode() {
  ws.sourceMode = !ws.sourceMode
  const effects = previewCompartment.reconfigure(previewExtensions(ws.sourceMode))
  for (const [path, state] of editorStates) {
    if (path === ws.active && view) {
      view.dispatch({ effects })
      editorStates.set(path, view.state)
    } else editorStates.set(path, state.update({ effects }).state)
  }
}

/** 从相册/文件中选择图片插入到光标处 */
export function insertImagesFromPicker() {
  const v = view
  const tab = activeTab()
  if (!v || tab?.status !== 'ready') return
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.multiple = true
  input.addEventListener('change', () => {
    if (input.files?.length && view === v) insertImageFiles(v, [...input.files])
  })
  input.click()
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
    shortcuts: [],
    spellcheck: settings.spellcheck,
    tabSize: settings.tabSize,
    sourceMode: ws.sourceMode,
    openLink: (href) => { void openMarkdownLink(ref.path, href) },
    resolveImage: (src) => {
      const url = resolveAssetUrl(ref.path, src)
      const entry = ws.entries.find((e) => url === '/api/v1/raw/' + encodePath(e.path))
      return entry ? imageUrl(entry.path) : url
    },
    onChange: (u) => {
      editorStates.set(ref.path, u.state)
      if (!u.transactions.some((tr) => tr.annotation(externalChange))) scheduleSave(ref.path)
    },
    extensions: [
      notePath.of(ref),
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.selectionSet) editorListeners.forEach((fn) => fn())
      }),
      pasteImages({
        canPaste: () => {
          if (!slot(ref.path).paused) return true
          toast('笔记正在移动，请完成后再粘贴或上传图片')
          return false
        },
        upload: (file) => api.upload(ref.path, file),
        importImage: (url) => api.importImage(ref.path, url),
        update: (change) => {
          const shown = view?.state.facet(notePath) === ref
          const state = shown ? view!.state : editorStates.get(ref.path)
          if (!state) throw new Error('粘贴所属笔记的编辑状态不存在')
          const spec = change(state)
          if (!spec) return
          if (shown) view!.dispatch(spec)
          else {
            const transaction = state.update(spec)
            editorStates.set(ref.path, transaction.state)
            if (transaction.docChanged) scheduleSave(ref.path)
          }
        },
        onError: (err) => toast('粘贴或图片导入失败：' + (err instanceof Error ? err.message : errorText(err))),
        onPending: (d) => {
          if (d === 1 && slot(ref.path).uploads === 0) toast('正在处理粘贴或图片导入…')
          slot(ref.path).uploads += d
        },
      }),
    ],
  })
}

function reconfigurePluginStates() {
  const effects = [languageCompartment.reconfigure(pluginLanguage()), pluginCompartment.reconfigure(pluginEditorExtensions()), pluginRefresh.of(null)]
  // 先计算全部新状态，失败时让注册方撤回；不让后台标签保留已停用扩展。
  const updates = [...editorStates].map(([path, state]) => {
    const current = path === ws.active && view ? view.state : state
    return { path, transaction: current.update({ effects }) }
  })
  for (const { path, transaction } of updates) {
    if (path === ws.active && view) view.dispatch(transaction)
    editorStates.set(path, transaction.state)
  }
}

const pluginWrite: PluginAPI['vault']['write'] = async (path, content, options) => {
  const tab = tabOf(path)
  const saved = slots.get(path)
  if ((tab && (tab.dirty || tab.status !== 'ready')) || saved?.inflight || saved?.uploads || saved?.paused || opsInFlight) throw new ApiError(409, '笔记有未保存修改或正在操作，请稍后重试')
  if (!options || (!('create' in options && options.create === true) && !('ifMatch' in options && typeof options.ifMatch === 'string' && options.ifMatch.length > 0))) throw new ApiError(400, '写入必须指定非空版本号或明确新建')
  const initialRevision = tab?.rev
  const initialSequence = saved?.seq ?? 0
  const rev = await api.writeFile(path, content, 'create' in options ? '' : options.ifMatch)
  // 用户可能已完成下一次保存，或已收到更新版本；迟到响应不能退回正文与 rev。
  if (tab && tabOf(path) === tab && tab.rev === initialRevision && (slots.get(path)?.seq ?? 0) === initialSequence && !tab.dirty && tab.status === 'ready' && !slots.get(path)?.inflight) { replaceDoc(path, content); tab.rev = rev }
  await refreshTree()
  return { rev }
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

// 保存失败会留在标签页状态中，flushAll 完成并不意味着可以安全刷新。
export function readyToReload(): boolean {
  return opsInFlight === 0 && !ws.tabs.some((t) => t.dirty || t.status === 'loading') &&
    [...slots.values()].every((s) => !s.uploads && !s.paused && !s.inflight)
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
  const s = slot(path)
  if (s.inflight || s.uploads || s.paused) {
    toast('笔记正在保存、上传或移动，请完成后再处理冲突')
    return
  }
  const seq = s.seq
  s.inflight = (async () => {
    try {
      const rev = await api.writeFile(path, content, tab.conflictRev ?? '')
      s.savedSeq = seq
      Object.assign(tab, { rev, status: 'ready', dirty: s.seq !== seq, conflictRev: undefined, saveError: undefined })
      if (s.seq === seq) await drafts.delete(path)
      if (!ws.entries.some((e) => e.path === path)) void refreshTree().catch((err) => toast('刷新目录失败：' + errorText(err)))
    } catch (err) {
      if (err instanceof ApiError && err.status === 412) {
        tab.conflictRev = typeof err.data.rev === 'string' ? err.data.rev : ''
        toast('服务器上的版本又变化了，请再次选择')
      } else toast('保存失败：' + errorText(err))
    }
  })()
  await s.inflight
  s.inflight = undefined
  if (tab.dirty && tab.status === 'ready') void flush(path)
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

export async function closeTab(path: string): Promise<boolean> {
  const busy = () => Boolean(slots.get(path)?.uploads || slots.get(path)?.paused)
  if (busy()) {
    toast('笔记正在上传或移动，完成后再关闭')
    return false
  }
  await flush(path)
  const i = ws.tabs.findIndex((t) => t.path === path)
  if (i < 0) return true
  const tab = ws.tabs[i]
  if (busy()) {
    toast('笔记正在上传或移动，完成后再关闭')
    return false
  }
  if (tab.dirty) {
    const seq = slot(path).seq
    const content = docOf(path)
    if (content === undefined) throw new Error('未保存笔记的编辑状态不存在')
    try {
      await drafts.put({ path, content, baseRev: tab.rev, updatedAt: Date.now() })
    } catch (err) {
      toast('本地草稿保存失败，已保留标签页：' + errorText(err))
      return false
    }
    if (tabOf(path) !== tab || slot(path).seq !== seq || busy()) return false
    toast('未保存的修改已保留为本地草稿')
  }
  const index = ws.tabs.indexOf(tab)
  if (index < 0) return true
  ws.tabs.splice(index, 1)
  forget(path)
  if (ws.active === path) ws.active = ws.tabs[Math.min(index, ws.tabs.length - 1)]?.path ?? null
  return true
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
  reconfigurePluginStates()
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
const treeWaiters: { resolve: () => void; reject: (reason: unknown) => void }[] = []

export function refreshTree(): Promise<void> {
  return new Promise((resolve, reject) => {
    treeWaiters.push({ resolve, reject })
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
  let entries: Entry[]
  try {
    entries = await api.tree()
  } catch (err) {
    treeFetching = false
    for (const waiter of treeWaiters.splice(0)) waiter.reject(err)
    return
  }
  treeFetching = false
  if (treeAgain || edits !== localTreeEdits || opsInFlight > 0) {
    // 有操作进行中时由 withOp 在全部结束后重新调度
    if (opsInFlight === 0) scheduleTreeRefresh()
    return
  }
  const oldImages = new Map(ws.entries.filter((e) => !e.dir && isImage(e.path)).map((e) => [e.path, e]))
  const nextPaths = new Set(entries.map((e) => e.path))
  const imagesChanged = entries.some((e) => !e.dir && isImage(e.path) && (e.mtime !== oldImages.get(e.path)?.mtime || e.size !== oldImages.get(e.path)?.size)) || [...oldImages.keys()].some((p) => !nextPaths.has(p))
  ws.entries = entries
  if (imagesChanged) view?.dispatch({ effects: refreshImages.of(null) })
  markMissingTabsDeleted()
  for (const waiter of treeWaiters.splice(0)) waiter.resolve()
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

export async function importNotes(dir: string, folder: string, files: File[]) {
  // refreshTree 必须等 withOp 结束，否则会等待自身释放操作计数。
  const result = await withOp(() => api.importNotes(dir, folder, files))
  ws.searchOpen = false
  try {
    await refreshTree()
  } catch (err) {
    toast('导入已完成，目录刷新失败：' + errorText(err))
  }
  return result
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
  if (entry && !entry.dir && path.endsWith(NOTE_EXT) && !name.endsWith(NOTE_EXT)) name += NOTE_EXT
  return joinPath(dirname(path), name)
}

export type FileResult = { ok: true } | { ok: false; error: string }
function operationFailed(error: string): FileResult {
  toast(error)
  return { ok: false, error }
}

export async function move(from: string, to: string): Promise<FileResult> {
  if (from === to) return { ok: true }
  if (creating.has(from) && !(await creating.get(from))) return operationFailed('笔记尚未创建成功')
  if (ws.entries.some((e) => e.path === to)) {
    return operationFailed(`“${basename(to)}”已存在`)
  }
  const result = await withOp<FileResult>(async () => {
    // 移动会更新仓库中的相对链接，先保存全部已打开笔记，沿用版本冲突保护。
    const impacted = () => ws.tabs.map((t) => t.path)
    const busy = () => impacted().some((p) => slots.get(p)?.uploads || slots.get(p)?.paused)
    if (busy()) {
      return operationFailed('笔记正在处理粘贴、上传或移动，请完成后再移动')
    }
    // 先保存待保存的修改，确保移动的是最新内容；移动期间暂停保存，避免写到旧路径
    await Promise.all(impacted().map((p) => flush(p)))
    // 等待保存时仍可能开始粘贴，须在取得移动占用前再次检查。
    if (busy()) {
      return operationFailed('笔记正在处理粘贴、上传或移动，请完成后再移动')
    }
    if (impacted().some((p) => { const tab = tabOf(p); return tab && (tab.dirty || tab.status !== 'ready') })) {
      return operationFailed('请先保存笔记并解决冲突，再移动文件')
    }
    const paused = impacted().map(slot)
    paused.forEach((s) => s.paused++)
    const snapshot = ws.entries
    let draftsMoved = false
    let remapped = false
    try {
      // 先确认持久草稿能够迁移；失败时服务器与界面均保留原路径。
      await drafts.move(from, to)
      draftsMoved = true
      remapped = true
      ws.entries = ws.entries.map((e) => ({ ...e, path: remapPath(e.path, from, to) ?? e.path }))
      remapOpenNotes(from, to)
      remapRecent(from, to)
      if (ws.image) ws.image = remapPath(ws.image, from, to) ?? ws.image
      if (ws.images) ws.images = remapPath(ws.images, from, to) ?? ws.images
      await api.move(from, to)
    } catch (err) {
      if (remapped) {
        ws.entries = snapshot
        remapOpenNotes(to, from)
        remapRecent(to, from)
        if (ws.image) ws.image = remapPath(ws.image, to, from) ?? ws.image
        if (ws.images) ws.images = remapPath(ws.images, to, from) ?? ws.images
      }
      if (draftsMoved) {
        try { await drafts.move(to, from) }
        catch (cause) { toast('恢复原路径草稿失败：' + (cause instanceof Error ? cause.message : errorText(cause))) }
      }
      return operationFailed('移动失败：' + (err instanceof Error ? err.message : errorText(err)))
    } finally {
      paused.forEach((s) => s.paused--)
    }
    // 笔记改名时服务器会改写正文中的图片链接，版本随之变化，需要重新同步
    await Promise.all(ws.tabs.map((t) => t.path).map(async (p) => {
      const tab = tabOf(p)
      if (!tab) return
      if (tab.dirty) {
        // 移动期间又有输入：本地内容仍含旧链接，交给用户选择
        const { rev } = await api.readFile(p)
        if (rev !== tab.rev) Object.assign(tab, { status: 'conflict', conflictRev: rev })
      } else await syncOpenTab(tab)
    })).catch((err) => toast('文件已移动，但同步笔记失败：' + errorText(err)))
    return { ok: true }
  })
  void refreshTree().catch((err) => toast('刷新目录失败：' + errorText(err)))
  return result
}

export async function remove(path: string): Promise<FileResult> {
  const entry = ws.entries.find((e) => e.path === path)
  if (!entry) return operationFailed('文件已不存在')
  return withOp<FileResult>(async () => {
    const paths = affected(path)
    await Promise.all(paths.map((p) => flush(p)))
    if (paths.some((p) => { const tab = tabOf(p); return tab && (tab.dirty || tab.status !== 'ready') })) return operationFailed('请先保存笔记并解决冲突，再删除文件')
    const snapshot = ws.entries
    ws.entries = ws.entries.filter((e) => remapPath(e.path, path, path) === null) // 去掉自身及其下所有条目
    for (const p of paths) {
      if (!(await closeTab(p))) { ws.entries = snapshot; return operationFailed('关闭笔记失败，未删除文件') }
    }
    try {
      const item = await api.deleteFile(path)
      if (ws.image && remapPath(ws.image, path, path) !== null) ws.image = null
      toast(`已删除“${basename(path).replace(/\.md$/, '')}”`, {
        label: '撤销',
        run: () => void restore(item.id),
      })
      return { ok: true }
    } catch (err) {
      ws.entries = snapshot
      return operationFailed('删除失败：' + errorText(err))
    }
  })
}

export async function restore(id: string) {
  try {
    const item = await api.restore(id)
    await refreshTree()
    if (!item.dir && item.path.endsWith(NOTE_EXT)) void openNote(item.path)
    else if (!item.dir && isImage(item.path)) ws.image = item.path
  } catch (err) {
    toast('恢复失败：' + errorText(err))
  }
}

// 版本只用于刷新浏览器图片，不改变 Markdown 中保存的相对路径。
export function imageUrl(path: string): string {
  const entry = ws.entries.find((e) => e.path === path)
  return '/api/v1/raw/' + encodePath(path) + (entry ? `?v=${entry.mtime}-${entry.size}` : '')
}

export async function replaceImage(path: string, file: File) {
  await withOp(() => api.replaceImage(path, file))
  try { await refreshTree() }
  catch (err) { toast('图片已替换，但刷新目录失败：' + errorText(err)) }
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
    } else throw err
  }
}

async function handleEvents(evs: VaultEvent[]) {
  for (const ev of evs) {
    if (ev.type === 'indexed') void refreshMetadata()
    else if (ev.type === 'settings') {
      void loadSettings().catch((err) => toast('同步设置失败：' + errorText(err)))
      void refreshPlugins()
    }
    else if (ev.type === 'plugins') void refreshPlugins()
    else if (ev.type === 'changed') {
      const tab = tabOf(ev.path!)
      // 自己保存产生的事件 rev 与本地一致；有本地修改时不覆盖，交由下次保存的冲突检测处理
      if (tab && tab.rev !== ev.rev) await syncOpenTab(tab)
    } else if (ev.type === 'moved') {
      if (ws.image) ws.image = remapPath(ws.image, ev.from!, ev.path!) ?? ws.image
      if (ws.images) ws.images = remapPath(ws.images, ev.from!, ev.path!) ?? ws.images
      const paused = affected(ev.from!).map(slot)
      paused.forEach((s) => s.paused++)
      try {
        // 已发出的保存仍可能写入旧键，先等其草稿事务结束。
        await Promise.all(paused.map((s) => s.inflight))
        try { await drafts.move(ev.from!, ev.path!) }
        catch (cause) {
          // 外部文件已移动，草稿失败不能阻止编辑器跟随；保留原记录并明确提示。
          toast('迁移本地草稿失败，原路径草稿已保留：' + (cause instanceof Error ? cause.message : errorText(cause)))
        }
        if (affected(ev.from!).length && !affected(ev.path!).length) remapOpenNotes(ev.from!, ev.path!)
        remapRecent(ev.from!, ev.path!)
      } finally { paused.forEach((s) => s.paused--) }
    } else if (ev.type === 'deleted') {
      if (ws.image === ev.path && opsInFlight === 0) ws.image = null
      const tab = tabOf(ev.path!)
      if (tab && tab.status === 'ready' && opsInFlight === 0) {
        tab.status = 'deleted'
        tab.conflictRev = ''
      }
    }
    if (ev.type === 'changed' || ev.type === 'moved' || ev.type === 'deleted') pluginEvents.dispatchEvent(new CustomEvent(ev.type, { detail: ev.type === 'moved' ? { from: ev.from!, path: ev.path! } : ev.type === 'changed' ? { path: ev.path!, rev: ev.rev! } : { path: ev.path! } }))
  }
  if (evs.some((event) => event.type === 'tree')) await resync()
}

async function resync() {
  void refreshMetadata()
  await refreshTree()
  await Promise.all(ws.tabs.map(syncOpenTab))
  pluginEvents.dispatchEvent(new CustomEvent('resync'))
  await refreshPlugins()
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
  // 设置读取失败不影响使用，沿用本地缓存的值
  const settingsLoaded = loadSettings().catch((err) => toast('读取设置失败：' + errorText(err)))
  await refreshTree()
  await settingsLoaded
  const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{"paths":[],"active":null}') as { paths: string[]; active: string | null; pinned?: string[] }
  const exists = new Set(ws.entries.map((e) => e.path))
  await Promise.all(saved.paths.filter((p) => exists.has(p)).map(openNote))
  try {
    await recoverDrafts()
  } catch (err) {
    toast('恢复本地草稿失败：' + errorText(err))
  }
  for (const tab of ws.tabs) tab.pinned = saved.pinned?.includes(tab.path) ?? false
  ws.active = saved.active && tabOf(saved.active) ? saved.active : (ws.tabs[0]?.path ?? null)
  let eventQueue = Promise.resolve()
  let stopped = false
  const enqueue = (work: () => Promise<void>) => {
    // 同步读取是异步的，后续批次不能越过前一批次的移动和正文更新。
    eventQueue = eventQueue.then(() => { if (!stopped) return work() }).catch((err) => toast('同步失败：' + errorText(err)))
  }
  const stopEvents = connectEvents({ onEvents: (events) => enqueue(() => handleEvents(events)), onResync: () => enqueue(resync) })
  disconnect = () => { stopped = true; stopEvents() }
  setPluginEditorHandlers(reconfigurePluginStates, pluginEditorFailure)
  startPlugins({
    notice: toast,
    openNote,
    writeNote: pluginWrite,
    getActiveNote: () => {
      const tab = activeTab()
      if (!tab) return null
      const state = view && ws.active === tab.path ? view.state : editorStates.get(tab.path)
      if (!state) return null
      return { path: tab.path, content: state.doc.toString(), rev: tab.rev, dirty: tab.dirty }
    },
  })
  // 重新登录后工作区会再次启动，以下全局监听只注册一次
  if (listenersInstalled) return
  listenersInstalled = true
  watch(
    () => ({ paths: ws.tabs.map((t) => t.path), active: ws.active, pinned: ws.tabs.filter((t) => t.pinned).map((t) => t.path) }),
    (tabs) => localStorage.setItem(TABS_KEY, JSON.stringify(tabs)),
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
  watch(
    () => ({ sidebarCollapsed: ws.sidebarCollapsed, outlineOpen: ws.outlineOpen }),
    (l) => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
      // 编辑区宽度变化，需要重新测量
      requestAnimationFrame(() => view?.requestMeasure())
    },
  )
  // 字号、正文宽度变化后行高随之改变，编辑器需要重新测量
  watch(
    () => [settings.fontSize, settings.contentWidth, settings.sidebarWidth],
    () => view?.requestMeasure(),
  )
  watch(
    () => [settings.spellcheck, settings.tabSize],
    () => {
      const effects = preferencesCompartment.reconfigure([
        EditorState.tabSize.of(settings.tabSize),
        EditorView.contentAttributes.of({ spellcheck: String(settings.spellcheck) }),
      ])
      for (const [path, state] of editorStates) {
        if (path === ws.active && view) {
          view.dispatch({ effects })
          editorStates.set(path, view.state)
        } else editorStates.set(path, state.update({ effects }).state)
      }
    },
  )
  window.addEventListener('rawmark-appearance', () => requestAnimationFrame(() => view?.requestMeasure()))
  window.addEventListener('rawmark-plugin-notice', (event) => toast((event as CustomEvent<string>).detail))
  // 页面隐藏/关闭前尽力发出待保存的修改（部分浏览器关闭标签页时只触发 pagehide）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAll(true)
  })
  window.addEventListener('pagehide', () => void flushAll(true))
  window.addEventListener('beforeunload', (event) => {
    if (!readyToReload()) event.preventDefault()
  })
  window.addEventListener('keydown', handleShortcut, true)
  // 软键盘弹出、编辑区变矮后，让光标保持可见
  trackVisualViewport(() => {
    if (view?.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 24 }) })
  })
}

// 内置命令不依赖工作区状态，模块载入时注册，排在组件注册的命令（如退出登录）之前
registerBuiltinCommands()

function registerBuiltinCommands() {
  for (const command of editorCommands) registerCommand({ ...command,
    when: () => ws.settings === null && ws.active !== null && !!view,
    run: () => { if (view) { command.run(view); view.focus() } },
  })
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
    { id: 'note.move', title: '移动当前笔记到…', when: hasNote, run: () => (ws.moving = ws.active) },
    { id: 'note.delete', title: '删除当前笔记', when: hasNote, run: () => void remove(ws.active!) },
    { id: 'note.insertImage', title: '插入图片…', when: hasNote, run: insertImagesFromPicker },
    // 浏览器不允许网页覆盖 Ctrl+W
    { id: 'tab.close', title: '关闭当前标签页', when: hasNote, run: () => void closeTab(ws.active!) },
    { id: 'app.settings', title: '设置', keys: ['Mod+,'], run: () => (ws.settings = 'index') },
    { id: 'view.sidebar', title: '显示/隐藏侧栏', keys: ['Mod+\\'], run: toggleSidebar },
    { id: 'view.outline', title: '显示/隐藏大纲', keys: ['Mod+Shift+O'], when: hasNote, run: () => (ws.outlineOpen = !ws.outlineOpen) },
    { id: 'view.source', title: '开启/关闭源码编辑', when: hasNote, run: toggleSourceMode },
    { id: 'app.trash', title: '打开回收站', run: () => (ws.settings = 'trash') },
    { id: 'note.share', title: '分享当前笔记', when: hasNote, run: () => (ws.sharing = ws.active) },
    { id: 'app.images', title: '管理根目录图片', run: () => (ws.images = '') },
    { id: 'app.shares', title: '管理分享链接', run: () => (ws.settings = 'shares') },
    { id: 'app.tokens', title: 'API 令牌', run: () => (ws.settings = 'tokens') },
  ]) {
    registerCommand(cmd)
  }
}

// 手机上侧栏是抽屉，电脑上折叠/展开
function toggleSidebar() {
  if (matchMedia('(max-width: 768px)').matches) ws.sidebarOpen = !ws.sidebarOpen
  else ws.sidebarCollapsed = !ws.sidebarCollapsed
}

// 需要在目录树中操作的命令：切回目录树，移动端打开侧栏
function withSidebar(fn: () => unknown) {
  ws.searchOpen = false
  ws.sidebarOpen = true
  ws.sidebarCollapsed = false
  void fn()
}

export function openSearch() {
  ws.searchOpen = true
  ws.sidebarOpen = true
  ws.sidebarCollapsed = false
  // 已打开时重新聚焦并全选，便于直接输入新的搜索词
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.rm-search-input')
    input?.focus()
    input?.select()
  })
}

export function stopWorkspace() {
  ws.image = null
  ws.images = null
  stopPlugins()
  disconnect?.()
  disconnect = undefined
}


async function openMarkdownLink(note: string, href: string) {
  const decoded = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1')
  let url: URL
  try { url = new URL(decoded, 'https://rawmark.local/' + encodePath(note)) }
  catch { toast('链接格式无效'); return }
  if (url.origin !== 'https://rawmark.local') {
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener')
    else toast('不支持的链接协议')
    return
  }
  const target = decodeURIComponent(url.pathname.slice(1))
  if (!ws.entries.some(e => e.path === target && !e.dir)) { toast('链接目标不存在：' + target); return }
  if (!target.endsWith('.md')) { window.open('/api/v1/raw/' + encodePath(target), '_blank', 'noopener'); return }
  await openNote(target)
  if (url.hash) requestAnimationFrame(() => {
    const state = editorStateOf(target), v = editorView()
    if (!state || !v || ws.active !== target) return
    const heading = decodeURIComponent(url.hash.slice(1)).toLocaleLowerCase()
    for (let i = 1; i <= state.doc.lines; i++) {
      const line = state.doc.line(i)
      const title = line.text.replace(/^#{1,6}\s+/, '').trim().toLocaleLowerCase()
      if (/^#{1,6}\s/.test(line.text) && (title === heading || title.replace(/\s+/g, '-') === heading)) {
        v.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'start' }) }); break
      }
    }
  })
}

export async function openReference(path: string, line: number) {
  await openNote(path)
  requestAnimationFrame(() => {
    const v = editorView()
    if (!v || ws.active !== path) return
    const pos = v.state.doc.line(Math.min(line, v.state.doc.lines)).from
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    v.focus()
  })
}
