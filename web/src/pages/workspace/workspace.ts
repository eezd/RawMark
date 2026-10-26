import type { VaultEvent } from '@@/apis/events/type'
import type { Entry, TreeIcon } from '@@/apis/tree/type'
import type { PluginAPI } from '@@/plugin-api'
import type { SettingsSection } from '@/pinia/stores/settings'
import { cleanupImagesApi, importImageApi, replaceImageApi, uploadFolderImageApi, uploadImageApi } from '@@/apis/assets'
import { connectEventsApi } from '@@/apis/events'
import { createFolderApi, deleteFileApi, getRawFileApi, importNotesApi, moveFileApi, writeFileApi } from '@@/apis/files'
import { restoreTrashApi } from '@@/apis/trash'
import { getTreeApi, setTreeIconApi } from '@@/apis/tree'
import { appearancePaused } from '@@/appearance/appearance'
import { locale, t as translate } from '@@/i18n/runtime'
// Workspace state and operations: tree, tabs, save queue, conflict handling, and live synchronization.
// File operations update the interface optimistically before requesting the server, rolling back on failure for immediate feedback.
import { decodeLinkDestination } from '@@/markdown/links'

import { pluginEditorFailure, refreshPlugins, startPlugins, stopPlugins } from '@@/plugins/host'
import { notePath, pluginEvents, pluginRefresh, pluginsPaused, setPluginEditorHandlers } from '@@/plugins/registry'
import { handleShortcut, registerCommand } from '@@/utils/commands'
import { readNoteFile } from '@@/utils/note-files'
import { toast } from '@@/utils/notifications'
import { basename, dirname, encodePath, isImage, joinPath, NOTE_EXT, resolveAssetUrl } from '@@/utils/paths'

import { imageResourceRoot, prepareResources } from '@@/utils/resource-tickets'
import { typoraKeys } from '@@/utils/typora-keys'
import { trackVisualViewport } from '@@/utils/viewport'
import { Annotation, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { CanceledError, isCancel } from 'axios'
import { nextTick, reactive, watch } from 'vue'
import { ApiError } from '@/http/axios'
import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { useUserStore } from '@/pinia/stores/user'
import { drafts } from './drafts'
import { createEditorState, insertImageFiles, languageCompartment, pasteImages, pluginCompartment, pluginEditorExtensions, pluginLanguage, preferencesCompartment, previewCompartment, previewExtensions } from './editor'
import { refreshImages } from './editor/livepreview'
import { editorLocale, localeCompartment } from './editor/locale'
import { editorCommands } from './editor/shortcuts'
import { refreshMetadata } from './metadata'

const { loadSettings, settings } = useSettingsStore(pinia)

export type TabStatus = 'loading' | 'ready' | 'conflict' | 'deleted' | 'error'

export interface Tab {
  path: string
  pinned?: boolean
  // Last revision synchronized with the server.
  rev: string
  status: TabStatus
  // Changes not yet saved successfully.
  dirty: boolean
  saveError?: string
  // Server revision during conflict; an empty string means the file no longer exists there.
  conflictRev?: string
}

const RECENT_KEY = 'rawmark.recent'
// Local interface state outside settings: sidebar collapse and outline panel.
const LAYOUT_KEY = 'rawmark.layout'
const layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as { sidebarCollapsed?: boolean, outlineOpen?: boolean }
const RECENT_MAX = 30

export const ws = reactive({
  entries: [] as Entry[],
  tabs: [] as Tab[],
  active: null as string | null,
  // Path currently being renamed inline in the tree.
  renaming: null as string | null,
  // Mobile sidebar drawer.
  sidebarOpen: false,
  // Show search instead of the tree in the sidebar.
  searchOpen: false,
  // Initial quick-switcher/command-palette query; null closes it, and leading > lists commands.
  switcher: null as string | null,
  // Open settings category; null closes it. index is the general entry, showing categories on phones and the first category on desktop.
  settings: (pluginsPaused ? 'plugins' : appearancePaused ? 'appearance' : null) as SettingsSection | 'index' | null,
  // "Move to..." dialog paths for notes or folders.
  moving: null as string | string[] | null,
  // Import destination folder; an empty string denotes the root.
  importing: null as string | null,
  // Image preview and management, independent of note tabs and drafts.
  image: null as string | null,
  images: null as string | null,
  imagesAll: false,
  // Desktop sidebar collapse state.
  sidebarCollapsed: layout.sidebarCollapsed ?? false,
  // Outline panel: persistent on the right on desktop, an overlay on phones.
  outlineOpen: layout.outlineOpen ?? false,
  sourceMode: false,
  focusMode: false,
  view: 'notes' as 'notes' | 'graph' | 'tags',
  // Recently opened notes, newest first.
  recent: JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[],
})

const SAVE_DELAY = 500
const RETRY_DELAY = 5000
const MAX_RETRIES = 12

// Keep the following state outside reactive: large immutable EditorState objects gain nothing from Vue proxies.
const editorStates = new Map<string, EditorState>()
// Each open note has a mutable reference through which editor extensions read its current path, updated on rename.
const noteRefs = new Map<string, { path: string }>()

interface SaveSlot {
  timer?: ReturnType<typeof setTimeout>
  inflight?: Promise<void>
  // Change and saved sequence numbers; equality means no pending changes.
  seq: number
  savedSeq: number
  uploads: number
  paused: number
  retries: number
}
const slots = new Map<string, SaveSlot>()

const user = useUserStore(pinia)
let workspaceRunning = false
let workspaceEpoch = 0
let draftPreserved: Promise<void> = Promise.resolve()

let view: EditorView | null = null
// In-flight local file operations; tree events during these operations must not determine whether tabs were deleted.
let opsInFlight = 0

const externalChange = Annotation.define<boolean>()

// Editor content/cursor subscribers, such as the outline, bypass Vue reactivity to avoid component updates on every keystroke.
const editorListeners = new Set<() => void>()
export function onEditorUpdate(fn: () => void): () => void {
  editorListeners.add(fn)
  return () => editorListeners.delete(fn)
}

export function tabOf(path: string | null): Tab | undefined {
  return path === null ? undefined : ws.tabs.find(t => t.path === path)
}

export function activeTab(): Tab | undefined {
  return tabOf(ws.active)
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : translate('common.network_error_check_your_connection_566064')
}

// ---- Editor state ----

export function attachView(v: EditorView | null) {
  view = v
}

/** Current editor view, accessed directly by controls such as the mobile toolbar. */
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
    } else {
      editorStates.set(path, state.update({ effects }).state)
    }
  }
}

/** Choose an image from photos/files and insert it at the cursor. */
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

// Note identity survives rename/move and determines whether the editor still displays the same note.
export function noteRefOf(path: string): { path: string } | undefined {
  return noteRefs.get(path)
}

// Called by the editor pane before tab switches to save view state, including cursor, non-scroll selection state, and undo history.
export function storeViewState(path: string, state: EditorState) {
  if (editorStates.has(path)) editorStates.set(path, state)
}

function buildState(path: string, doc: string): EditorState {
  const version = user.getSessionVersion()
  const ref = { path }
  noteRefs.set(path, ref)
  const isCurrentNote = () => version === user.getSessionVersion() && noteRefs.get(ref.path) === ref
  return createEditorState({
    doc,
    shortcuts: [],
    spellcheck: settings.spellcheck,
    tabSize: settings.tabSize,
    sourceMode: ws.sourceMode,
    openLink: (href) => {
      void openMarkdownLink(ref.path, href)
    },
    resolveImage: (src) => {
      const url = resolveAssetUrl(ref.path, src)
      const entry = ws.entries.find(e => url === `/api/v1/raw/${encodePath(e.path)}`)
      return entry ? imageUrl(entry.path) : url.startsWith('/api/v1/raw/') ? imageResourceRoot() + url.slice('/api/v1/raw/'.length) : url
    },
    onChange: (u) => {
      editorStates.set(ref.path, u.state)
      if (!u.transactions.some(tr => tr.annotation(externalChange))) scheduleSave(ref.path)
    },
    extensions: [
      notePath.of(ref),
      EditorView.updateListener.of((u) => {
        if (u.docChanged || u.selectionSet) editorListeners.forEach(fn => fn())
      }),
      pasteImages({
        canPaste: () => {
          if (!isCurrentNote()) return false
          if (!slot(ref.path).paused) return true
          toast(translate('workspace.this_note_is_moving_finish_d105e5'))
          return false
        },
        upload: (file) => {
          if (!isCurrentNote()) throw new CanceledError(translate('workspace.the_note_receiving_this_paste_a59580'))
          return uploadImageApi({ note: ref.path, file }).then(({ data }) => data.link)
        },
        importImage: (url) => {
          if (!isCurrentNote()) throw new CanceledError(translate('workspace.the_note_receiving_this_paste_a59580'))
          return importImageApi({ note: ref.path, url }).then(({ data }) => data.link)
        },
        update: (change) => {
          if (!isCurrentNote()) return
          const shown = view?.state.facet(notePath) === ref
          const state = shown ? view!.state : editorStates.get(ref.path)
          if (!state) throw new Error(translate('workspace.the_editor_state_for_the_028961'))
          const spec = change(state)
          if (!spec) return
          if (shown) {
            view!.dispatch(spec)
          } else {
            const transaction = state.update(spec)
            editorStates.set(ref.path, transaction.state)
            if (transaction.docChanged) scheduleSave(ref.path)
          }
        },
        onError: (err) => {
          if (isCurrentNote() && !isCancel(err)) toast(translate('workspace.paste_or_image_import_failed_09d4e6', { p0: err instanceof Error ? err.message : errorText(err) }))
        },
        onPending: (d) => {
          if (!isCurrentNote()) return
          if (d === 1 && slot(ref.path).uploads === 0) toast(translate('workspace.processing_paste_or_image_import_023dad'))
          slot(ref.path).uploads += d
        },
      }),
    ],
  })
}

function reconfigurePluginStates() {
  const effects = [languageCompartment.reconfigure(pluginLanguage()), pluginCompartment.reconfigure(pluginEditorExtensions()), pluginRefresh.of(null)]
  // Compute every new state first so the registering party can roll back on failure; background tabs must not retain disabled extensions.
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
  if ((tab && (tab.dirty || tab.status !== 'ready')) || saved?.inflight || saved?.uploads || saved?.paused || opsInFlight) throw new ApiError(409, translate('workspace.this_note_has_unsaved_changes_f14427'))
  if (!options || (!('create' in options && options.create === true) && !('ifMatch' in options && typeof options.ifMatch === 'string' && options.ifMatch.length > 0))) throw new ApiError(400, translate('workspace.a_write_requires_a_non_b12fd4'))
  const initialRevision = tab?.rev
  const initialSequence = saved?.seq ?? 0
  const rev = (await writeFileApi({ path, content, ifMatch: 'create' in options ? '' : options.ifMatch })).data.rev
  // A later save or newer revision may already exist; late responses must not revert contents or rev.
  if (tab && tabOf(path) === tab && tab.rev === initialRevision && (slots.get(path)?.seq ?? 0) === initialSequence && !tab.dirty && tab.status === 'ready' && !slots.get(path)?.inflight) {
    replaceDoc(path, content); tab.rev = rev
  }
  await refreshTree()
  return { rev }
}

// Replace document contents with server text by changing only the difference between shared prefix/suffix, preserving the cursor where possible and bypassing undo history.
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

// ---- Save queue ----

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

// Immediately save pending changes for one note; keepalive attempts delivery when the page hides or closes.
export async function flush(path: string, keepalive = false): Promise<void> {
  const version = user.getSessionVersion()
  const s = slots.get(path)
  if (!s) return
  clearTimeout(s.timer)
  while (s.inflight) await s.inflight
  if (version !== user.getSessionVersion() || slots.get(path) !== s) return
  const tab = tabOf(path)
  if (!tab || tab.status !== 'ready' || s.seq === s.savedSeq) return
  if (s.paused || s.uploads) {
    // Defer saves during image uploads or file moves to avoid temporary blob: URLs or writes to old paths.
    s.timer = setTimeout(() => void flush(path), SAVE_DELAY)
    return
  }
  const content = docOf(path)
  if (content === undefined) return
  const seq = s.seq
  const baseRev = tab.rev
  s.inflight = (async () => {
    // Run draft persistence and the request in parallel; waiting for IndexedDB first often prevents the request from starting during page close.
    // Drafts are a recovery fallback; draft-write failures do not block saving itself.
    const draftSaved = drafts.put({ path, content, baseRev, updatedAt: Date.now() }).catch(err => console.warn('写入本地草稿失败', err))
    try {
      const rev = (await writeFileApi({ path, content, ifMatch: baseRev, keepalive })).data.rev
      await draftSaved
      user.assertSession(version)
      tab.rev = rev
      tab.saveError = undefined
      s.savedSeq = seq
      s.retries = 0
      if (s.seq === seq) {
        tab.dirty = false
        await drafts.delete(path)
      }
    } catch (err) {
      if (isCancel(err)) return
      if (err instanceof ApiError && err.status === 412) {
        const serverRev = typeof err.data.rev === 'string' ? err.data.rev : ''
        tab.status = serverRev ? 'conflict' : 'deleted'
        tab.conflictRev = serverRev
      } else if (!(err instanceof ApiError) || err.status >= 500) {
        // Network/server failures can be retried; the local draft preserves contents.
        tab.saveError = s.retries < MAX_RETRIES ? translate('workspace.save_failed_retrying_d62793') : translate('workspace.save_failed_check_your_connection_c0913f')
        if (s.retries++ < MAX_RETRIES) s.timer = setTimeout(() => void flush(path), RETRY_DELAY)
      } else {
        tab.saveError = translate('workspace.save_failed_6ba723', { p0: err.message })
      }
    }
  })()
  await s.inflight
  s.inflight = undefined
  if (version !== user.getSessionVersion() || slots.get(path) !== s) return
  if (s.seq !== s.savedSeq && tab.status === 'ready' && !s.timer) scheduleSave(path)
}

export function retrySave(path: string) {
  slot(path).retries = 0
  void flush(path)
}

export async function flushAll(keepalive = false) {
  await Promise.all([...slots.keys()].map(p => flush(p, keepalive)))
}

// Save failures remain in tab state; completion of flushAll does not guarantee a safe refresh.
export function readyToReload(): boolean {
  return opsInFlight === 0 && !ws.tabs.some(t => t.dirty || t.status === 'loading')
    && [...slots.values()].every(s => !s.uploads && !s.paused && !s.inflight)
}

// ---- Conflict handling ----

// Discard local changes and load the server version.
export async function useServerVersion(path: string) {
  const tab = tabOf(path)
  if (!tab) return
  try {
    const { content, rev } = await readNoteFile(path)
    replaceDoc(path, content)
    const s = slot(path)
    s.savedSeq = s.seq
    Object.assign(tab, { rev, status: 'ready', dirty: false, conflictRev: undefined, saveError: undefined })
    await drafts.delete(path)
  } catch (err) {
    if (isCancel(err)) return
    toast(translate('workspace.load_failed_396d55', { p0: errorText(err) }))
  }
}

// Keep local changes and overwrite the server version, recreating the file if deleted there.
export async function keepLocalVersion(path: string) {
  const version = user.getSessionVersion()
  const tab = tabOf(path)
  const content = docOf(path)
  if (!tab || content === undefined) return
  const s = slot(path)
  if (s.inflight || s.uploads || s.paused) {
    toast(translate('workspace.this_note_is_saving_uploading_c23675'))
    return
  }
  const seq = s.seq
  s.inflight = (async () => {
    try {
      const rev = (await writeFileApi({ path, content, ifMatch: tab.conflictRev ?? '' })).data.rev
      s.savedSeq = seq
      Object.assign(tab, { rev, status: 'ready', dirty: s.seq !== seq, conflictRev: undefined, saveError: undefined })
      if (s.seq === seq) await drafts.delete(path)
      if (!ws.entries.some(e => e.path === path)) {
        void refreshTree().catch((err) => {
          if (!isCancel(err)) toast(translate('workspace.could_not_refresh_the_file_b5f68b', { p0: errorText(err) }))
        })
      }
    } catch (err) {
      if (isCancel(err)) return
      if (err instanceof ApiError && err.status === 412) {
        tab.conflictRev = typeof err.data.rev === 'string' ? err.data.rev : ''
        toast(translate('workspace.the_server_version_changed_again_594f7d'))
      } else {
        toast(translate('workspace.save_failed_6ba723', { p0: errorText(err) }))
      }
    }
  })()
  await s.inflight
  s.inflight = undefined
  if (version !== user.getSessionVersion() || slots.get(path) !== s) return
  if (tab.dirty && tab.status === 'ready') void flush(path)
}

// ---- Open and focus (quick switcher and search results) ----

interface RevealTarget {
  path: string
  line: number
  terms: string[]
}
// The note may not be loaded or its editor visible yet; the editor pane performs this after displaying the note.
let pendingReveal: RevealTarget | null = null

/** Open a note and focus the editor; line > 0 targets that 1-based line and selects its first search-term match. */
export async function openAt(path: string, line = 0, terms: string[] = []) {
  pendingReveal = { path, line, terms }
  if (path === ws.active && view && editorStates.has(path)) {
    ws.sidebarOpen = false
    revealPending(view, path)
  } else {
    await openNote(path)
  }
}

/** Called after the editor pane displays the note; true means the requested line was reached, so do not restore the old scroll position. */
export function revealPending(v: EditorView, path: string): boolean {
  const r = pendingReveal
  if (!r || r.path !== path) return false
  pendingReveal = null
  // Focus opens software keyboards on touch devices and covers content; focus only devices with a mouse.
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

// ---- Tabs ----

export async function openNote(path: string) {
  const version = user.getSessionVersion()
  ws.view = 'notes'
  ws.images = null
  ws.sidebarOpen = false
  // New tree notes appear optimistically; wait for actual creation before reading them.
  const pending = creating.get(path)
  if (pending && !(await pending)) return
  user.assertSession(version)
  if (tabOf(path)) {
    ws.active = path
    return
  }
  const tab: Tab = { path, rev: '', status: 'loading', dirty: false }
  ws.tabs.push(tab)
  ws.active = path
  try {
    const { content, rev } = await readNoteFile(path)
    editorStates.set(path, buildState(path, content))
    const t = tabOf(path)
    if (t) Object.assign(t, { rev, status: 'ready' })
  } catch (err) {
    if (isCancel(err)) return
    const t = tabOf(path)
    if (t) t.status = 'error'
    toast(translate('workspace.could_not_open_0ed1e1', { p0: errorText(err) }))
  }
}

export async function closeTab(path: string): Promise<boolean> {
  const version = user.getSessionVersion()
  const busy = () => Boolean(slots.get(path)?.uploads || slots.get(path)?.paused)
  if (busy()) {
    toast(translate('workspace.this_note_is_uploading_or_349b3d'))
    return false
  }
  await flush(path)
  user.assertSession(version)
  const i = ws.tabs.findIndex(t => t.path === path)
  if (i < 0) return true
  const tab = ws.tabs[i]
  if (busy()) {
    toast(translate('workspace.this_note_is_uploading_or_349b3d'))
    return false
  }
  if (tab.dirty) {
    const seq = slot(path).seq
    const content = docOf(path)
    if (content === undefined) throw new Error(translate('workspace.the_editor_state_for_this_248447'))
    try {
      await drafts.put({ path, content, baseRev: tab.rev, updatedAt: Date.now() })
      user.assertSession(version)
    } catch (err) {
      if (isCancel(err)) return false
      toast(translate('workspace.could_not_save_the_local_cc0e42', { p0: errorText(err) }))
      return false
    }
    if (tabOf(path) !== tab || slot(path).seq !== seq || busy()) return false
    toast(translate('workspace.unsaved_changes_retained_as_a_8cb2ab'))
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

// Replace path prefixes; moving a folder changes every descendant path together.
function remapPath(p: string, from: string, to: string): string | null {
  if (p === from) return to
  if (p.startsWith(`${from}/`)) return to + p.slice(from.length)
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
  ws.recent = ws.recent.map(p => remapPath(p, from, to) ?? p)
}

function affected(path: string): string[] {
  return ws.tabs.map(t => t.path).filter(p => p === path || p.startsWith(`${path}/`))
}

// ---- Directory tree ----

// Tree refresh permits one request at a time; discard and refetch if another refresh or local operation makes its result stale.
// Local operations update the tree optimistically; stale results would erase new entries, such as a new note's rename input.
// Waiting callers settle together after the next accepted result or request failure.
let treeTimer: ReturnType<typeof setTimeout> | undefined
let treeFetching = false
let treeAgain = false
let localTreeEdits = 0
const treeWaiters: { resolve: () => void, reject: (reason: unknown) => void }[] = []

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
  const version = user.getSessionVersion()
  treeFetching = true
  treeAgain = false
  const edits = localTreeEdits
  let entries: Entry[]
  try {
    entries = (await getTreeApi()).data.entries
    user.assertSession(version)
  } catch (err) {
    if (isCancel(err)) return
    treeFetching = false
    for (const waiter of treeWaiters.splice(0)) waiter.reject(err)
    return
  }
  treeFetching = false
  if (treeAgain || edits !== localTreeEdits || opsInFlight > 0) {
    // During active operations, withOp reschedules once all operations finish.
    if (opsInFlight === 0) scheduleTreeRefresh()
    return
  }
  const oldImages = new Map(ws.entries.filter(e => !e.dir && isImage(e.path)).map(e => [e.path, e]))
  const nextPaths = new Set(entries.map(e => e.path))
  const imagesChanged = entries.some(e => !e.dir && isImage(e.path) && (e.mtime !== oldImages.get(e.path)?.mtime || e.size !== oldImages.get(e.path)?.size)) || [...oldImages.keys()].some(p => !nextPaths.has(p))
  ws.entries = entries
  if (imagesChanged) view?.dispatch({ effects: refreshImages.of(null) })
  markMissingTabsDeleted()
  for (const waiter of treeWaiters.splice(0)) waiter.resolve()
}

function markMissingTabsDeleted() {
  const exists = new Set(ws.entries.map(e => e.path))
  for (const tab of ws.tabs) {
    if (tab.status === 'ready' && !exists.has(tab.path)) {
      tab.status = 'deleted'
      tab.conflictRev = ''
    }
  }
}

function uniqueName(dir: string, base: string, ext: string): string {
  const taken = new Set(ws.entries.map(e => e.path))
  for (let i = 0; ; i++) {
    const name = base + (i ? ` ${i}` : '') + ext
    if (!taken.has(joinPath(dir, name))) return joinPath(dir, name)
  }
}

async function withOp<T>(fn: () => Promise<T>): Promise<T> {
  const epoch = workspaceEpoch
  opsInFlight++
  localTreeEdits++
  try {
    return await fn()
  } finally {
    if (epoch === workspaceEpoch) {
      localTreeEdits++
      if (--opsInFlight === 0 && treeWaiters.length) scheduleTreeRefresh()
    }
  }
}

export async function saveTreeIcon(path: string, icon: TreeIcon | null) {
  await withOp(() => setTreeIconApi({ path, icon }).then(({ data }) => data))
  try {
    await refreshTree()
  } catch (err) {
    if (isCancel(err)) return
    toast(translate('workspace.icon_saved_but_the_file_72a5c2', { p0: errorText(err) }))
  }
}

export async function createNote(dir: string) {
  const path = uniqueName(dir, translate('workspace.untitled_67bee6'), NOTE_EXT)
  ws.renaming = path
  await createNoteAt(path)
}

// In-flight creation: immediately show the rename input, but wait for actual file creation before renaming.
const creating = new Map<string, Promise<boolean>>()

/** Create and open an empty note at the requested path and report success; the server creates missing parent folders. */
export async function createNoteAt(path: string, content = ''): Promise<boolean> {
  ws.view = 'notes'
  ws.images = null
  const done = createNoteFile(path, content)
  creating.set(path, done)
  try {
    return await done
  } finally {
    if (creating.get(path) === done) creating.delete(path)
  }
}

async function createNoteFile(path: string, content: string): Promise<boolean> {
  const exists = new Set(ws.entries.map(e => e.path))
  const added = [path]
  for (let d = dirname(path); d && !exists.has(d); d = dirname(d)) added.push(d)
  ws.entries.push(...added.map((p, i) => ({ path: p, dir: i > 0, size: 0, mtime: Date.now() })))
  return withOp(async () => {
    try {
      const rev = (await writeFileApi({ path, content, ifMatch: '' })).data.rev
      ws.tabs.push({ path, rev, status: 'ready', dirty: false })
      editorStates.set(path, buildState(path, content))
      ws.active = path
      return true
    } catch (err) {
      if (isCancel(err)) return false
      ws.entries = ws.entries.filter(e => !added.includes(e.path))
      if (ws.renaming === path) ws.renaming = null
      toast(translate('workspace.could_not_create_note_2760ce', { p0: errorText(err) }))
      return false
    }
  })
}

export async function importNotes(dir: string, folder: string, files: File[]) {
  // refreshTree must wait until withOp ends, or it would wait for its own operation count to be released.
  const result = await withOp(() => importNotesApi({ dir, folder, files }).then(({ data }) => data))
  ws.searchOpen = false
  try {
    await refreshTree()
  } catch (err) {
    if (isCancel(err)) throw err
    toast(translate('workspace.import_complete_but_the_file_52460f', { p0: errorText(err) }))
  }
  return result
}

export async function createFolder(dir: string) {
  const path = uniqueName(dir, translate('workspace.new_folder_84244a'), '')
  ws.entries.push({ path, dir: true, size: 0, mtime: Date.now() })
  ws.renaming = path
  await withOp(async () => {
    try {
      await createFolderApi({ path })
    } catch (err) {
      if (isCancel(err)) return
      ws.entries = ws.entries.filter(e => e.path !== path)
      if (ws.renaming === path) ws.renaming = null
      toast(translate('workspace.could_not_create_folder_bc6447', { p0: errorText(err) }))
    }
  })
}

export function renameTarget(path: string, name: string): string | null {
  name = name.trim().replace(/\//g, '')
  if (!name || name.startsWith('.')) return null
  const entry = ws.entries.find(e => e.path === path)
  if (entry && !entry.dir && path.endsWith(NOTE_EXT) && !name.endsWith(NOTE_EXT)) name += NOTE_EXT
  return joinPath(dirname(path), name)
}

export type FileResult = { ok: true } | { ok: false, error: string }
function operationFailed(error: string, owner: 'operation' | 'caller'): FileResult {
  if (owner === 'operation') toast(error)
  return { ok: false, error }
}

export async function move(from: string, to: string, errorOwner: 'operation' | 'caller' = 'operation'): Promise<FileResult> {
  const version = user.getSessionVersion()
  if (from === to) return { ok: true }
  if (creating.has(from) && !(await creating.get(from))) return operationFailed(translate('workspace.this_note_has_not_been_77a7a9'), errorOwner)
  user.assertSession(version)
  if (ws.entries.some(e => e.path === to)) {
    return operationFailed(translate('workspace.already_exists_6af434', { p0: basename(to) }), errorOwner)
  }
  const result = await withOp<FileResult>(async () => {
    // Moves update relative vault links; save all open notes first, retaining revision-conflict protection.
    const impacted = () => ws.tabs.map(t => t.path)
    const busy = () => impacted().some(p => slots.get(p)?.uploads || slots.get(p)?.paused)
    if (busy()) {
      return operationFailed(translate('workspace.this_note_is_processing_a_8c2cce'), errorOwner)
    }
    // Save pending edits first so the latest contents move; pause saving during the move to avoid writing to old paths.
    await Promise.all(impacted().map(p => flush(p)))
    user.assertSession(version)
    // Pasting may start while awaiting saves; check again before acquiring the move lock.
    if (busy()) {
      return operationFailed(translate('workspace.this_note_is_processing_a_8c2cce'), errorOwner)
    }
    if (impacted().some((p) => {
      const tab = tabOf(p); return tab && (tab.dirty || tab.status !== 'ready')
    })) {
      return operationFailed(translate('workspace.save_your_notes_and_resolve_5500d4'), errorOwner)
    }
    const paused = impacted().map(slot)
    paused.forEach(s => s.paused++)
    const snapshot = ws.entries
    let draftsMoved = false
    let remapped = false
    try {
      // Verify persistent drafts can migrate first; on failure, keep original paths on both the server and interface.
      await drafts.move(from, to)
      user.assertSession(version)
      draftsMoved = true
      remapped = true
      ws.entries = ws.entries.map(e => ({ ...e, path: remapPath(e.path, from, to) ?? e.path }))
      remapOpenNotes(from, to)
      remapRecent(from, to)
      if (ws.image) ws.image = remapPath(ws.image, from, to) ?? ws.image
      if (ws.images) ws.images = remapPath(ws.images, from, to) ?? ws.images
      await moveFileApi({ from, to })
    } catch (err) {
      if (isCancel(err)) throw err
      if (remapped) {
        ws.entries = snapshot
        remapOpenNotes(to, from)
        remapRecent(to, from)
        if (ws.image) ws.image = remapPath(ws.image, to, from) ?? ws.image
        if (ws.images) ws.images = remapPath(ws.images, to, from) ?? ws.images
      }
      if (draftsMoved) {
        try {
          await drafts.move(to, from)
        } catch (cause) {
          toast(translate('workspace.could_not_restore_the_draft_e5f464', { p0: cause instanceof Error ? cause.message : errorText(cause) }))
        }
      }
      return operationFailed(translate('workspace.move_failed_04b0a9', { p0: err instanceof Error ? err.message : errorText(err) }), errorOwner)
    } finally {
      paused.forEach(s => s.paused--)
    }
    // The server rewrites image links when renaming notes, changing their revisions and requiring resynchronization.
    await Promise.all(ws.tabs.map(t => t.path).map(async (p) => {
      const tab = tabOf(p)
      if (!tab) return
      if (tab.dirty) {
        // Input during the move still contains old links; let the user resolve it.
        const { rev } = await readNoteFile(p)
        if (rev !== tab.rev) Object.assign(tab, { status: 'conflict', conflictRev: rev })
      } else {
        await syncOpenTab(tab)
      }
    })).catch((err) => {
      if (isCancel(err)) throw err
      toast(translate('workspace.file_moved_but_note_synchronization_b9ff79', { p0: errorText(err) }))
    })
    return { ok: true }
  })
  void refreshTree().catch((err) => {
    if (!isCancel(err)) toast(translate('workspace.could_not_refresh_the_file_b5f68b', { p0: errorText(err) }))
  })
  return result
}

export async function remove(path: string, errorOwner: 'operation' | 'caller' = 'operation'): Promise<FileResult> {
  const version = user.getSessionVersion()
  const entry = ws.entries.find(e => e.path === path)
  if (!entry) return operationFailed(translate('workspace.file_no_longer_exists_4eb446'), errorOwner)
  return withOp<FileResult>(async () => {
    const paths = affected(path)
    await Promise.all(paths.map(p => flush(p)))
    user.assertSession(version)
    if (paths.some((p) => {
      const tab = tabOf(p); return tab && (tab.dirty || tab.status !== 'ready')
    })) {
      return operationFailed(translate('workspace.save_your_notes_and_resolve_5981a5'), errorOwner)
    }
    const snapshot = ws.entries
    ws.entries = ws.entries.filter(e => remapPath(e.path, path, path) === null) // Remove the item and all descendants.
    for (const p of paths) {
      if (!(await closeTab(p))) {
        ws.entries = snapshot; return operationFailed(translate('workspace.could_not_close_the_note_cd2a80'), errorOwner)
      }
    }
    user.assertSession(version)
    try {
      const item = (await deleteFileApi(path)).data
      if (ws.image && remapPath(ws.image, path, path) !== null) ws.image = null
      toast(translate('workspace.deleted_86a46b', { p0: basename(path).replace(/\.md$/, '') }), {
        get label() {
          return translate('workspace.undo_926a50')
        },
        run: () => void restore(item.id),
      })
      return { ok: true }
    } catch (err) {
      if (isCancel(err)) throw err
      ws.entries = snapshot
      return operationFailed(translate('common.could_not_delete_9619d7', { p0: errorText(err) }), errorOwner)
    }
  })
}

export async function restore(id: string) {
  try {
    const item = (await restoreTrashApi(id)).data
    await refreshTree()
    if (!item.dir && item.path.endsWith(NOTE_EXT)) void openNote(item.path)
    else if (!item.dir && isImage(item.path)) ws.image = item.path
  } catch (err) {
    if (isCancel(err)) return
    toast(translate('workspace.restore_failed_283a6e', { p0: errorText(err) }))
  }
}

// The version refreshes browser images only; relative Markdown paths remain unchanged.
export function imageUrl(path: string): string {
  const entry = ws.entries.find(e => e.path === path)
  return imageResourceRoot() + encodePath(path) + (entry ? `?v=${entry.mtime}-${entry.size}` : '')
}

export async function replaceImage(path: string, file: File) {
  await withOp(() => replaceImageApi({ path, file }).then(({ data }) => data))
  try {
    await refreshTree()
  } catch (err) {
    if (isCancel(err)) return
    toast(translate('workspace.image_replaced_but_the_file_bb4848', { p0: errorText(err) }))
  }
}

// ---- Live synchronization ----

async function syncOpenTab(tab: Tab) {
  const s = slots.get(tab.path)
  if (tab.status !== 'ready' || tab.dirty || s?.inflight) return
  try {
    const { content, rev } = await readNoteFile(tab.path)
    if (rev === tab.rev || tab.dirty) return
    replaceDoc(tab.path, content)
    tab.rev = rev
  } catch (err) {
    if (isCancel(err)) return
    if (err instanceof ApiError && err.status === 404) {
      tab.status = 'deleted'
      tab.conflictRev = ''
    } else {
      throw err
    }
  }
}

async function handleEvents(evs: VaultEvent[]) {
  const version = user.getSessionVersion()
  const epoch = workspaceEpoch
  for (const ev of evs) {
    user.assertSession(version)
    if (ev.type === 'indexed') {
      void refreshMetadata()
    } else if (ev.type === 'settings') {
      void loadSettings().catch((err) => {
        if (!isCancel(err)) toast(translate('workspace.could_not_synchronize_settings_7e5bb1', { p0: errorText(err) }))
      })
      await refreshPlugins()
    } else if (ev.type === 'plugins') {
      await refreshPlugins()
    } else if (ev.type === 'changed') {
      const tab = tabOf(ev.path!)
      // Own-save events match the local rev; do not overwrite local edits, and let the next save detect conflicts.
      if (tab && tab.rev !== ev.rev) await syncOpenTab(tab)
    } else if (ev.type === 'moved') {
      if (ws.image) ws.image = remapPath(ws.image, ev.from!, ev.path!) ?? ws.image
      if (ws.images) ws.images = remapPath(ws.images, ev.from!, ev.path!) ?? ws.images
      const paused = affected(ev.from!).map(slot)
      paused.forEach(s => s.paused++)
      try {
        // In-flight saves may still write the old key; wait for their draft transactions first.
        await Promise.all(paused.map(s => s.inflight))
        user.assertSession(version)
        if (epoch !== workspaceEpoch) return
        try {
          await drafts.move(ev.from!, ev.path!)
        } catch (cause) {
          // The external file already moved, so draft failures must not prevent editor tracking; retain the original record and report failure explicitly.
          toast(translate('workspace.could_not_migrate_the_local_4c513a', { p0: cause instanceof Error ? cause.message : errorText(cause) }))
        }
        user.assertSession(version)
        if (epoch !== workspaceEpoch) return
        if (affected(ev.from!).length && !affected(ev.path!).length) remapOpenNotes(ev.from!, ev.path!)
        remapRecent(ev.from!, ev.path!)
      } finally {
        paused.forEach(s => s.paused--)
      }
    } else if (ev.type === 'deleted') {
      if (ws.image === ev.path && opsInFlight === 0) ws.image = null
      const tab = tabOf(ev.path!)
      if (tab && tab.status === 'ready' && opsInFlight === 0) {
        tab.status = 'deleted'
        tab.conflictRev = ''
      }
    }
    user.assertSession(version)
    if (epoch !== workspaceEpoch) return
    if (ev.type === 'changed' || ev.type === 'moved' || ev.type === 'deleted') pluginEvents.dispatchEvent(new CustomEvent(ev.type, { detail: ev.type === 'moved' ? { from: ev.from!, path: ev.path! } : ev.type === 'changed' ? { path: ev.path!, rev: ev.rev! } : { path: ev.path! } }))
  }
  if (evs.some(event => event.type === 'tree')) await resync()
}

async function resync() {
  const version = user.getSessionVersion()
  const epoch = workspaceEpoch
  void refreshMetadata()
  await refreshTree()
  user.assertSession(version)
  if (epoch !== workspaceEpoch) return
  await Promise.all(ws.tabs.map(syncOpenTab))
  user.assertSession(version)
  if (epoch !== workspaceEpoch) return
  pluginEvents.dispatchEvent(new CustomEvent('resync'))
  await refreshPlugins()
}

// ---- Startup ----

const TABS_KEY = 'rawmark.tabs'

// Restore unsaved drafts: continue saving if the server revision is unchanged; otherwise enter conflict state for user resolution.
async function recoverDrafts() {
  const version = user.getSessionVersion()
  for (const d of await drafts.all()) {
    user.assertSession(version)
    try {
      const { content, rev } = await readNoteFile(d.path)
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
      } else {
        Object.assign(tab, { status: 'conflict', conflictRev: rev, dirty: true })
      }
    } catch (err) {
      if (isCancel(err)) throw err
      if (!(err instanceof ApiError) || err.status !== 404) throw err
      ws.tabs.push({ path: d.path, rev: '', status: 'deleted', dirty: true, conflictRev: '' })
      editorStates.set(d.path, buildState(d.path, d.content))
    }
  }
}

let disconnect: (() => void) | undefined
let listenersInstalled = false

export async function startWorkspace() {
  const version = user.getSessionVersion()
  await draftPreserved
  user.assertSession(version)
  workspaceRunning = false
  await prepareResources()
  user.assertSession(version)
  // Settings-read failures do not prevent use; retain locally cached values.
  const settingsLoaded = loadSettings().catch((err) => {
    if (!isCancel(err)) toast(translate('workspace.could_not_load_settings_246415', { p0: errorText(err) }))
  })
  await refreshTree()
  await settingsLoaded
  user.assertSession(version)
  const saved = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{"paths":[],"active":null}') as { paths: string[], active: string | null, pinned?: string[] }
  const exists = new Set(ws.entries.map(e => e.path))
  await Promise.all(saved.paths.filter(p => exists.has(p)).map(openNote))
  try {
    await recoverDrafts()
  } catch (err) {
    if (isCancel(err)) throw err
    toast(translate('workspace.could_not_restore_the_local_a275e8', { p0: errorText(err) }))
  }
  user.assertSession(version)
  for (const tab of ws.tabs) tab.pinned = saved.pinned?.includes(tab.path) ?? false
  ws.active = saved.active && tabOf(saved.active) ? saved.active : (ws.tabs[0]?.path ?? null)
  workspaceRunning = true
  let eventQueue = Promise.resolve()
  let stopped = false
  const enqueue = (work: () => Promise<void>) => {
    // Synchronization reads are asynchronous; later batches must not overtake earlier moves or content updates.
    eventQueue = eventQueue.then(() => {
      if (!stopped) return work()
    }).catch((err) => {
      if (!stopped && version === user.getSessionVersion() && !isCancel(err)) toast(translate('workspace.synchronization_failed_c6eeea', { p0: errorText(err) }))
    })
  }
  const stopEvents = connectEventsApi({ onEvents: events => enqueue(() => handleEvents(events)), onResync: () => enqueue(resync) })
  disconnect = () => {
    stopped = true; stopEvents()
  }
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
  // The workspace starts again after signing in; register the following global listeners only once.
  if (listenersInstalled) return
  listenersInstalled = true
  watch(
    () => ({ paths: ws.tabs.map(t => t.path), active: ws.active, pinned: ws.tabs.filter(t => t.pinned).map(t => t.path) }),
    (tabs) => {
      if (workspaceRunning) localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
    },
    // Record tabs opened during startup immediately, including while waiting for tree refresh.
    { immediate: true },
  )
  watch(
    () => ws.active,
    (p) => {
      if (p) ws.recent = [p, ...ws.recent.filter(r => r !== p)].slice(0, RECENT_MAX)
    },
    { immediate: true },
  )
  watch(
    () => ws.recent,
    r => localStorage.setItem(RECENT_KEY, JSON.stringify(r)),
  )
  watch(
    () => ({ sidebarCollapsed: ws.sidebarCollapsed, outlineOpen: ws.outlineOpen, focusMode: ws.focusMode }),
    (l) => {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
      // Editor width changed; request remeasurement.
      requestAnimationFrame(() => view?.requestMeasure())
    },
  )
  watch(locale, (value) => {
    const effects = localeCompartment.reconfigure(editorLocale.of(value))
    for (const [path, state] of editorStates) {
      if (path === ws.active && view) {
        view.dispatch({ effects })
        editorStates.set(path, view.state)
      } else {
        editorStates.set(path, state.update({ effects }).state)
      }
    }
  })
  // Font-size and text-width changes affect line heights; request editor remeasurement.
  watch(
    () => [settings.uiFont, settings.uiFontSize, settings.fontSize, settings.contentWidth, settings.sidebarWidth, settings.textFont, settings.codeFont, settings.lineHeight],
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
        } else {
          editorStates.set(path, state.update({ effects }).state)
        }
      }
    },
  )
  window.addEventListener('rawmark-appearance', () => requestAnimationFrame(() => view?.requestMeasure()))
  window.addEventListener('rawmark-plugin-notice', event => toast((event as CustomEvent<string>).detail))
  // Attempt to send pending saves before page hide/close; some browsers fire only pagehide on tab close.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushAll(true)
  })
  window.addEventListener('pagehide', () => void flushAll(true))
  window.addEventListener('beforeunload', (event) => {
    if (!readyToReload()) event.preventDefault()
  })
  window.addEventListener('keydown', (event) => {
    if (workspaceRunning) handleShortcut(event)
  }, true)
  // Keep the cursor visible when the software keyboard reduces editor height.
  trackVisualViewport(() => {
    if (view?.hasFocus) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 24 }) })
  })
}

// Built-in commands do not depend on workspace state; register at module load before component commands such as sign-out.
registerBuiltinCommands()

function registerBuiltinCommands() {
  for (const command of editorCommands) {
    registerCommand({ ...command, get title() {
      return command.title
    }, when: () => ws.view === 'notes' && ws.settings === null && ws.images === null && ws.active !== null && !!view, run: () => {
      if (view) {
        command.run(view); view.focus()
      }
    } })
  }
  const hasNote = () => ws.active !== null
  const toggleSwitcher = (initial: string) => {
    ws.switcher = ws.switcher === null ? initial : null
  }
  for (const cmd of [
    { id: 'app.quickOpen', get title() {
      return translate('workspace.quick_open_note_0d376f')
    }, run: () => toggleSwitcher('') },
    { id: 'app.commandPalette', get title() {
      return translate('workspace.command_palette_4b495d')
    }, run: () => toggleSwitcher('>') },
    { id: 'app.search', get title() {
      return translate('workspace.full_text_search_a6c47a')
    }, run: openSearch },
    { id: 'note.new', get title() {
      return translate('workspace.new_note_d3d2d9')
    }, run: () => withSidebar(() => createNote('')) },
    { id: 'folder.new', get title() {
      return translate('workspace.new_folder_84244a')
    }, run: () => withSidebar(() => createFolder('')) },
    { id: 'note.save', get title() {
      return translate('workspace.save_current_note_5a7e29')
    }, when: hasNote, run: () => void flush(ws.active!) },
    { id: 'note.rename', get title() {
      return translate('workspace.rename_current_note_de288b')
    }, when: hasNote, run: () => withSidebar(() => (ws.renaming = ws.active)) },
    { id: 'note.move', get title() {
      return translate('workspace.move_current_note_to_f1fc16')
    }, when: hasNote, run: () => (ws.moving = ws.active) },
    { id: 'note.delete', get title() {
      return translate('workspace.delete_current_note_657a00')
    }, when: hasNote, run: () => void remove(ws.active!) },
    { id: 'note.insertImage', get title() {
      return translate('workspace.insert_image_52c554')
    }, when: hasNote, run: insertImagesFromPicker },
    { id: 'tab.close', get title() {
      return translate('workspace.close_current_tab_cc8a4e')
    }, when: hasNote, run: () => void closeTab(ws.active!) },
    { id: 'app.settings', get title() {
      return translate('common.settings_df3d58')
    }, run: () => (ws.settings = 'index') },
    { id: 'view.sidebar', get title() {
      return translate('workspace.show_hide_sidebar_96b1a4')
    }, run: toggleSidebar },
    { id: 'view.outline', get title() {
      return translate('workspace.show_hide_outline_1da8d2')
    }, when: hasNote, run: () => (ws.outlineOpen = !ws.outlineOpen) },
    { id: 'view.source', get title() {
      return translate('workspace.toggle_source_editing_602b33')
    }, when: hasNote, run: toggleSourceMode },
    { id: 'view.focus', get title() {
      return translate('workspace.toggle_focus_mode_b52fb6')
    }, when: hasNote, run: () => (ws.focusMode = !ws.focusMode) },
    { id: 'app.trash', get title() {
      return translate('workspace.open_trash_8a939d')
    }, run: () => (ws.settings = 'trash') },
    { id: 'app.images', get title() {
      return translate('workspace.manage_root_folder_images_fed368')
    }, run: () => {
      ws.imagesAll = false; ws.images = ''
    } },
    { id: 'app.tokens', get title() {
      return translate('common.api_tokens_79db53')
    }, run: () => (ws.settings = 'account') },
  ]) {
    registerCommand({ ...cmd, get title() {
      return cmd.title
    }, keys: typoraKeys(cmd.id) })
  }
}

// The sidebar is a drawer on phones and collapsible on desktop.
function toggleSidebar() {
  if (matchMedia('(max-width: 768px)').matches) ws.sidebarOpen = !ws.sidebarOpen
  else ws.sidebarCollapsed = !ws.sidebarCollapsed
}

// For tree operations, switch back to the tree and open the sidebar on mobile.
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
  // If already open, refocus and select all so users can immediately enter a new query.
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.rm-search-input')
    input?.focus()
    input?.select()
  })
}

export function stopWorkspace() {
  workspaceRunning = false
  workspaceEpoch++
  const dirty = ws.tabs.filter(tab => tab.dirty).map((tab) => {
    const content = docOf(tab.path)
    return content === undefined ? Promise.resolve() : drafts.put({ path: tab.path, content, baseRev: tab.rev, updatedAt: Date.now() })
  })
  draftPreserved = Promise.all(dirty).then(() => {}).catch((error) => {
    console.error('保留本地草稿失败', error); toast(translate('workspace.could_not_save_the_local_4b21e1'))
  })
  for (const slot of slots.values()) clearTimeout(slot.timer)
  clearTimeout(treeTimer)
  for (const waiter of treeWaiters.splice(0)) waiter.reject(new CanceledError(translate('workspace.workspace_closed_221ea3')))
  treeFetching = false
  treeAgain = false
  opsInFlight = 0
  localTreeEdits++
  creating.clear()
  slots.clear()
  editorStates.clear()
  noteRefs.clear()
  view = null
  ws.tabs = []
  ws.active = null
  ws.entries = []
  ws.switcher = null
  ws.settings = null
  ws.moving = null
  ws.importing = null
  ws.renaming = null
  ws.image = null
  ws.images = null
  stopPlugins()
  disconnect?.()
  disconnect = undefined
}

async function openMarkdownLink(note: string, href: string) {
  const decoded = decodeLinkDestination(href)
  let url: URL
  try {
    url = new URL(decoded, `https://rawmark.local/${encodePath(note)}`)
  } catch {
    toast(translate('workspace.invalid_link_format_651be5')); return
  }
  if (url.origin !== 'https://rawmark.local') {
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener')
    else toast(translate('workspace.unsupported_link_protocol_cf426f'))
    return
  }
  let target: string
  try {
    target = decodeURIComponent(url.pathname.slice(1)); decodeURIComponent(url.hash.slice(1))
  } catch {
    toast(translate('workspace.invalid_link_encoding_2c6a7e')); return
  }
  if (!ws.entries.some(e => e.path === target && !e.dir)) {
    toast(translate('workspace.link_target_does_not_exist_2503d1', { p0: target })); return
  }
  if (!target.endsWith('.md')) {
    const response = await getRawFileApi(target)
    const url = URL.createObjectURL(response.data)
    const link = Object.assign(document.createElement('a'), { href: url, download: basename(target) }); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    return
  }
  await openNote(target)
  if (url.hash) {
    requestAnimationFrame(() => {
      const state = editorStateOf(target); const v = editorView()
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

export async function uploadFolderImages(folder: string, files: File[]) {
  const version = user.getSessionVersion()
  const failures: string[] = []
  let uploaded = 0
  await withOp(async () => {
    for (const file of files) {
      try {
        user.assertSession(version)
        await uploadFolderImageApi({ folder, file }); uploaded++
      } catch (error) {
        if (isCancel(error)) throw error
        failures.push(`${file.name}：${errorText(error)}`)
      }
    }
  })
  await refreshTree()
  return { uploaded, failures }
}

export async function cleanupImages(paths: string[]) {
  const version = user.getSessionVersion()
  await flushAll()
  user.assertSession(version)
  if (!readyToReload()) throw new Error(translate('workspace.finish_saving_pasting_uploading_or_e67d3d'))
  const result = await withOp(() => cleanupImagesApi({ paths }).then(({ data }) => data))
  await refreshTree()
  await refreshMetadata()
  return result
}
