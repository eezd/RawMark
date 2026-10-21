// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { insertImageFiles } from '../editor/paste'
import { api, ApiError } from './api'
import { drafts, type Draft } from './drafts'
import { connectEvents } from './events'
import { pluginEvents } from '../plugins/registry'
import { attachView, closeTab, editorStateOf, flush, keepLocalVersion, importNotes, move, readyToReload, openNote, refreshTree, startWorkspace, stopWorkspace, storeViewState, ws } from './workspace'

vi.mock('./events', () => ({ connectEvents: vi.fn(() => () => {}) }))

let view: EditorView | undefined
beforeEach(() => { vi.spyOn(drafts, 'move').mockResolvedValue(undefined) })
afterEach(() => {
  stopWorkspace()
  attachView(null)
  view?.destroy()
  view = undefined
  vi.restoreAllMocks()
})

describe('事件同步', () => {
  it('目录移动映射整个已打开的子树，并把未保存输入写入新路径', async () => {
    const tree = vi.spyOn(api, 'tree').mockResolvedValue([{ path: 'from/note.md', dir: false, size: 0, mtime: 0 }])
    vi.spyOn(api, 'settings').mockResolvedValue({})
    vi.spyOn(api, 'plugins').mockResolvedValue([])
    vi.spyOn(drafts, 'all').mockResolvedValue([])
    vi.spyOn(drafts, 'put').mockImplementation(async (draft) => draft.path)
    const saved = new Map<string, string>()
    vi.spyOn(api, 'writeFile').mockImplementation(async (path, content) => { saved.set(path, content); return 'r2' })
    await startWorkspace()
    const v = await edit('from/note.md')
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '尚未保存的输入' } })
    tree.mockResolvedValue([{ path: 'to/note.md', dir: false, size: 0, mtime: 0 }])
    vi.mocked(connectEvents).mock.lastCall![0].onEvents([{ type: 'moved', from: 'from', path: 'to' }, { type: 'tree' }])
    await vi.waitFor(() => expect(ws.active).toBe('to/note.md'))
    expect(drafts.move).toHaveBeenCalledWith('from', 'to')
    expect(editorStateOf('from/note.md')).toBeUndefined()
    expect(editorStateOf('to/note.md')!.doc.toString()).toBe('尚未保存的输入')
    await flush('to/note.md')
    expect(saved.get('to/note.md')).toBe('尚未保存的输入')
    expect(saved.has('from/note.md')).toBe(false)
    await closeTab('to/note.md')
  })

  it('正文同步后才通知插件，同步失败时不广播成功且不阻塞后续批次', async () => {
    const entries = [{ path: 'sync.md', dir: false, size: 0, mtime: 0 }]
    vi.spyOn(api, 'tree').mockResolvedValue(entries)
    vi.spyOn(api, 'settings').mockResolvedValue({})
    vi.spyOn(api, 'plugins').mockResolvedValue([])
    vi.spyOn(drafts, 'all').mockResolvedValue([])
    vi.spyOn(drafts, 'delete').mockResolvedValue(undefined)
    const read = vi.spyOn(api, 'readFile').mockResolvedValue({ content: '旧正文', rev: 'r1' })
    await startWorkspace()
    await openNote('sync.md')
    const handlers = vi.mocked(connectEvents).mock.lastCall![0]
    const observed: string[] = []
    let resyncs = 0
    const changed = () => observed.push(editorStateOf('sync.md')!.doc.toString())
    const resync = () => { resyncs++ }
    pluginEvents.addEventListener('changed', changed)
    pluginEvents.addEventListener('resync', resync)
    try {
      let finish!: (value: { content: string; rev: string }) => void
      read.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      handlers.onEvents([{ type: 'changed', path: 'sync.md', rev: 'r2' }])
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      expect(observed).toEqual([])
      finish({ content: '新正文', rev: 'r2' })
      await vi.waitFor(() => expect(observed).toEqual(['新正文']))
      read.mockRejectedValueOnce(new ApiError(500, '正文读取失败'))
      handlers.onEvents([{ type: 'changed', path: 'sync.md', rev: 'r3' }])
      await vi.waitFor(() => expect(ws.toasts.some((toast) => toast.text.includes('正文读取失败'))).toBe(true))
      expect(observed).toEqual(['新正文'])
      vi.mocked(api.tree).mockRejectedValueOnce(new ApiError(500, '目录读取失败'))
      handlers.onResync()
      await vi.waitFor(() => expect(ws.toasts.some((toast) => toast.text.includes('目录读取失败'))).toBe(true))
      expect(resyncs).toBe(0)
      read.mockResolvedValue({ content: '恢复后的正文', rev: 'r3' })
      handlers.onResync()
      await vi.waitFor(() => expect(resyncs).toBe(1))
      expect(editorStateOf('sync.md')!.doc.toString()).toBe('恢复后的正文')
    } finally {
      pluginEvents.removeEventListener('changed', changed)
      pluginEvents.removeEventListener('resync', resync)
      await closeTab('sync.md')
    }
  })
})

async function edit(path: string) {
  vi.spyOn(api, 'readFile').mockResolvedValue({ content: '原文', rev: 'r1' })
  vi.spyOn(drafts, 'delete').mockResolvedValue(undefined)
  ws.entries.push({ path, dir: false, size: 0, mtime: 0 })
  await openNote(path)
  view = new EditorView({ parent: document.body, state: editorStateOf(path)! })
  attachView(view)
  return view
}

describe('保存与关闭', () => {
  it('关闭冲突标签前持久化冲突之后的新输入，草稿失败时保留标签', async () => {
    const v = await edit('conflict.md')
    vi.spyOn(api, 'writeFile').mockRejectedValue(new ApiError(412, '版本冲突', { rev: 'r2' }))
    const saved = new Map<string, Draft>()
    const put = vi.spyOn(drafts, 'put').mockImplementation(async (draft) => { saved.set(draft.path, draft); return draft.path })
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '冲突前' } })
    await flush('conflict.md')
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '冲突后新增' } })
    put.mockRejectedValueOnce(new Error('存储失败'))
    expect(await closeTab('conflict.md')).toBe(false)
    expect(ws.tabs.some((tab) => tab.path === 'conflict.md')).toBe(true)
    expect(await closeTab('conflict.md')).toBe(true)
    expect(saved.get('conflict.md')?.content).toBe('冲突后新增')
    expect(editorStateOf('conflict.md')).toBeUndefined()
  })

  it('冲突保存期间的新输入继续保存，不能标成已保存', async () => {
    const v = await edit('race.md')
    vi.spyOn(drafts, 'put').mockImplementation(async (draft) => draft.path)
    const contents: string[] = []
    let finish!: (rev: string) => void
    vi.spyOn(api, 'writeFile').mockImplementation(async (_path, content) => {
      contents.push(content)
      return contents.length === 1 ? new Promise<string>((resolve) => { finish = resolve }) : 'r3'
    })
    const tab = ws.tabs.find((tab) => tab.path === 'race.md')!
    Object.assign(tab, { status: 'conflict', conflictRev: 'r2' })
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '请求发出时' } })
    const saving = keepLocalVersion('race.md')
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '等待期间又输入' } })
    finish('r2-new')
    await saving
    await flush('race.md')
    expect(contents).toEqual(['请求发出时', '等待期间又输入'])
    expect(tab.dirty).toBe(false)
    await closeTab('race.md')
  })

  it('网页图片导入期间切换标签，转换内容仍保存到原笔记', async () => {
    const v = await edit('网页.md')
    vi.spyOn(drafts, 'put').mockImplementation(async (draft) => draft.path)
    const contents = new Map<string, string>()
    vi.spyOn(api, 'writeFile').mockImplementation(async (path, content) => { contents.set(path, content); return 'r2' })
    let finish!: (link: string) => void
    vi.spyOn(api, 'importImage').mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    const data = new DataTransfer()
    data.setData('text/plain', '网页标题')
    data.setData('text/html', '<h1>网页标题</h1><img src="https://example.com/a.png">')
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(await closeTab('网页.md')).toBe(false)
    await openNote('other.md')
    storeViewState('网页.md', v.state)
    v.setState(editorStateOf('other.md')!)
    finish('网页.assets/hash.png')
    await vi.waitFor(() => expect(editorStateOf('网页.md')!.doc.toString()).toContain('网页.assets/hash.png'))
    await flush('网页.md')
    expect(contents.get('网页.md')).toContain('# 网页标题')
    expect(contents.get('网页.md')).toContain('网页.assets/hash.png')
    expect(v.state.doc.toString()).toBe('原文')
    await closeTab('网页.md')
    await closeTab('other.md')
  })

  it('切换标签后上传结果仍写回原笔记，上传期间不能关闭', async () => {
    const v = await edit('image.md')
    vi.spyOn(drafts, 'put').mockImplementation(async (draft) => draft.path)
    const contents = new Map<string, string>()
    vi.spyOn(api, 'writeFile').mockImplementation(async (path, content) => { contents.set(path, content); return 'r2' })
    let finish!: (link: string) => void
    vi.spyOn(api, 'upload').mockImplementation(() => new Promise<string>((resolve) => { finish = resolve }))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    insertImageFiles(v, [new File(['image'], 'image.png', { type: 'image/png' })])
    expect(await closeTab('image.md')).toBe(false)
    await openNote('other.md')
    v.setState(editorStateOf('other.md')!)
    finish('image.assets/ok.png')
    await vi.waitFor(() => expect(editorStateOf('image.md')!.doc.toString()).toContain('image.assets/ok.png'))
    await flush('image.md')
    expect(contents.get('image.md')).toBe('![](image.assets/ok.png)原文')
    expect(v.state.doc.toString()).toBe('原文')
    await closeTab('image.md')
    await closeTab('other.md')
  })

  it('图片上传期间不能移动笔记或其父目录', async () => {
    const v = await edit('upload/note.md')
    vi.spyOn(api, 'tree').mockResolvedValue([{ path: 'upload/note.md', dir: false, size: 0, mtime: 0 }])
    vi.spyOn(drafts, 'put').mockImplementation(async (draft) => draft.path)
    vi.spyOn(api, 'writeFile').mockResolvedValue('r2')
    const moving = vi.spyOn(api, 'move').mockResolvedValue(new Response())
    let finish!: (link: string) => void
    vi.spyOn(api, 'upload').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pending-move')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    insertImageFiles(v, [new File(['image'], 'image.png', { type: 'image/png' })])
    await move('upload/note.md', 'renamed.md')
    await move('upload', 'renamed-folder')
    expect(moving).not.toHaveBeenCalled()
    expect(ws.active).toBe('upload/note.md')
    await refreshTree()
    finish('note.assets/hash.png')
    await vi.waitFor(() => expect(v.state.doc.toString()).toContain('note.assets/hash.png'))
    await closeTab('upload/note.md')
  })

  it('移动期间拒绝新的图片和网页粘贴，保留原选区内容', async () => {
    const v = await edit('moving.md')
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.length } })
    let finish!: (response: Response) => void
    vi.spyOn(api, 'move').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    vi.spyOn(api, 'tree').mockResolvedValue([{ path: 'moved.md', dir: false, size: 0, mtime: 0 }])
    const upload = vi.spyOn(api, 'upload')
    const importing = vi.spyOn(api, 'importImage')
    const moving = move('moving.md', 'moved.md')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(insertImageFiles(v, [new File(['image'], 'image.png', { type: 'image/png' })])).toBe(true)
    const data = new DataTransfer()
    data.setData('text/html', '<h1>不应插入</h1>')
    data.setData('text/plain', '不应插入')
    v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    expect(v.state.doc.toString()).toBe('原文')
    expect(v.state.selection.main.from).toBe(0)
    expect(v.state.selection.main.to).toBe(2)
    expect(upload).not.toHaveBeenCalled()
    expect(importing).not.toHaveBeenCalled()
    finish(new Response())
    await moving
    await refreshTree()
    await closeTab('moved.md')
  })

  it('草稿迁移失败时不移动文件，服务端失败时恢复草稿路径', async () => {
    await edit('draft-move.md')
    vi.spyOn(api, 'tree').mockResolvedValue([{ path: 'draft-move.md', dir: false, size: 0, mtime: 0 }])
    const moving = vi.spyOn(api, 'move').mockRejectedValue(new ApiError(500, '移动失败'))
    vi.mocked(drafts.move).mockRejectedValueOnce(new Error('草稿不可写'))
    await move('draft-move.md', 'draft-moved.md')
    expect(moving).not.toHaveBeenCalled()
    expect(ws.active).toBe('draft-move.md')
    await move('draft-move.md', 'draft-moved.md')
    expect(ws.active).toBe('draft-move.md')
    expect(drafts.move).toHaveBeenLastCalledWith('draft-moved.md', 'draft-move.md')
    await refreshTree()
    await closeTab('draft-move.md')
  })
})

describe('导入', () => {
  it('上传期间阻止刷新，成功后刷新目录，并保留真实的成功结果', async () => {
    ws.tabs = []
    const result = { paths: ['导入'], notes: 1, assets: 0, warnings: [] }
    let finish!: (value: typeof result) => void
    vi.spyOn(api, 'importNotes').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    vi.spyOn(api, 'tree').mockResolvedValue([{ path: '导入', dir: true, size: 0, mtime: 0 }])
    const importing = importNotes('', '导入', [new File(['正文'], 'test.md')])
    expect(readyToReload()).toBe(false)
    finish(result)
    expect(await importing).toEqual(result)
    expect(ws.entries.some((e) => e.path === '导入')).toBe(true)
    expect(readyToReload()).toBe(true)
    vi.mocked(api.importNotes).mockResolvedValueOnce(result)
    vi.mocked(api.tree).mockRejectedValueOnce(new ApiError(500, '目录读取失败'))
    expect(await importNotes('', '导入', [])).toEqual(result)
    expect(ws.toasts.some((t) => t.text.includes('导入已完成，目录刷新失败'))).toBe(true)
  })

  it('失败保留错误并释放操作占用', async () => {
    ws.tabs = []
    vi.spyOn(api, 'importNotes').mockRejectedValue(new ApiError(409, '目标已存在'))
    await expect(importNotes('', '导入', [])).rejects.toMatchObject({ status: 409, message: '目标已存在' })
    expect(readyToReload()).toBe(true)
  })
})
