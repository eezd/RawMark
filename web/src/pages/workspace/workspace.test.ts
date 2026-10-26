import type { Draft } from './drafts'
import * as assetsApi from '@@/apis/assets'
import { connectEventsApi } from '@@/apis/events'
import * as filesApi from '@@/apis/files'
import * as fontsApi from '@@/apis/fonts'
import * as pluginsApi from '@@/apis/plugins'
import * as settingsApi from '@@/apis/settings'
import * as trashApi from '@@/apis/trash'
import * as treeApi from '@@/apis/tree'
import * as noteFiles from '@@/utils/note-files'

// @vitest-environment happy-dom
import { toasts } from '@@/utils/notifications'
import { EditorView } from '@codemirror/view'
import { flushPromises } from '@vue/test-utils'
import { CanceledError, isCancel } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/http/axios'

import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { apiSuccess } from '../../../tests/api-response'
import { pluginEvents } from '../../common/plugins/registry'
import { drafts } from './drafts'
import { insertImageFiles } from './editor/paste'
import { attachView, closeTab, createNoteAt, editorStateOf, flush, importNotes, keepLocalVersion, move, openNote, readyToReload, refreshTree, remove, replaceImage, restore, startWorkspace, stopWorkspace, storeViewState, ws } from './workspace'

vi.mock('@@/apis/events', () => ({ connectEventsApi: vi.fn(() => () => {}) }))

let view: EditorView | undefined
beforeEach(() => {
  vi.spyOn(drafts, 'move').mockResolvedValue(undefined)
})
afterEach(() => {
  stopWorkspace()
  attachView(null)
  view?.destroy()
  view = undefined
  vi.restoreAllMocks()
})

describe('事件同步', () => {
  it('目录移动映射整个已打开的子树，并把未保存输入写入新路径', async () => {
    const tree = vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'from/note.md', dir: false, size: 0, mtime: 0 }] }))
    vi.spyOn(settingsApi, 'getSettingsApi').mockResolvedValue(apiSuccess({}))
    vi.spyOn(fontsApi, 'getFontsApi').mockResolvedValue(apiSuccess({ fonts: [] }))
    vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] }))
    vi.spyOn(drafts, 'all').mockResolvedValue([])
    vi.spyOn(drafts, 'put').mockImplementation(async draft => draft.path)
    const saved = new Map<string, string>()
    vi.spyOn(filesApi, 'writeFileApi').mockImplementation(async ({ path, content }) => {
      saved.set(path, content); return apiSuccess({ rev: await ('r2') })
    })
    await startWorkspace()
    const v = await edit('from/note.md')
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '尚未保存的输入' } })
    tree.mockResolvedValue(apiSuccess({ entries: [{ path: 'to/note.md', dir: false, size: 0, mtime: 0 }] }))
    vi.mocked(connectEventsApi).mock.lastCall![0].onEvents([{ type: 'moved', from: 'from', path: 'to' }, { type: 'tree' }])
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
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries }))
    vi.spyOn(settingsApi, 'getSettingsApi').mockResolvedValue(apiSuccess({}))
    vi.spyOn(fontsApi, 'getFontsApi').mockResolvedValue(apiSuccess({ fonts: [] }))
    vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] }))
    vi.spyOn(drafts, 'all').mockResolvedValue([])
    vi.spyOn(drafts, 'delete').mockResolvedValue(undefined)
    const read = vi.spyOn(noteFiles, 'readNoteFile').mockResolvedValue({ content: '旧正文', rev: 'r1' })
    await startWorkspace()
    await openNote('sync.md')
    const handlers = vi.mocked(connectEventsApi).mock.lastCall![0]
    const observed: string[] = []
    let resyncs = 0
    const changed = () => observed.push(editorStateOf('sync.md')!.doc.toString())
    const resync = () => {
      resyncs++
    }
    pluginEvents.addEventListener('changed', changed)
    pluginEvents.addEventListener('resync', resync)
    try {
      let finish!: (value: { content: string, rev: string }) => void
      read.mockImplementationOnce(() => new Promise((resolve) => {
        finish = resolve
      }))
      handlers.onEvents([{ type: 'changed', path: 'sync.md', rev: 'r2' }])
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
      expect(observed).toEqual([])
      finish({ content: '新正文', rev: 'r2' })
      await vi.waitFor(() => expect(observed).toEqual(['新正文']))
      read.mockRejectedValueOnce(new ApiError(500, '正文读取失败'))
      handlers.onEvents([{ type: 'changed', path: 'sync.md', rev: 'r3' }])
      await vi.waitFor(() => expect(toasts.some(toast => toast.text.includes('正文读取失败'))).toBe(true))
      expect(observed).toEqual(['新正文'])
      vi.mocked(treeApi.getTreeApi).mockRejectedValueOnce(new ApiError(500, '目录读取失败'))
      handlers.onResync()
      await vi.waitFor(() => expect(toasts.some(toast => toast.text.includes('目录读取失败'))).toBe(true))
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
  vi.spyOn(noteFiles, 'readNoteFile').mockResolvedValue({ content: '原文', rev: 'r1' })
  vi.spyOn(drafts, 'delete').mockResolvedValue(undefined)
  ws.entries.push({ path, dir: false, size: 0, mtime: 0 })
  await openNote(path)
  view = new EditorView({ parent: document.body, state: editorStateOf(path)! })
  attachView(view)
  return view
}

describe('笔记打开与创建', () => {
  it('从图片库新建或打开已有笔记时显示笔记视图', async () => {
    vi.spyOn(filesApi, 'writeFileApi').mockResolvedValue(apiSuccess({ rev: 'r1' }))
    vi.spyOn(drafts, 'delete').mockResolvedValue(undefined)
    ws.images = ''
    ws.view = 'graph'
    expect(await createNoteAt('gallery-create.md', '正文')).toBe(true)
    expect(ws.images).toBeNull()
    expect(ws.view).toBe('notes')
    expect(ws.active).toBe('gallery-create.md')
    ws.images = ''
    await openNote('gallery-create.md')
    expect(ws.images).toBeNull()
    expect(editorStateOf('gallery-create.md')?.doc.toString()).toBe('正文')
    await closeTab('gallery-create.md')
  })

  it.each([true, false])('创建期间打开同一路径，创建成功=%s，不产生重复或错误标签', async (succeeds) => {
    const path = `pending-create-${succeeds}.md`
    let finish!: (rev: string) => void
    let fail!: (error: Error) => void
    vi.spyOn(filesApi, 'writeFileApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof filesApi.writeFileApi>>['data']['rev']>((resolve, reject) => {
      finish = resolve; fail = reject
    })).then(value => apiSuccess({ rev: value })))
    vi.spyOn(noteFiles, 'readNoteFile').mockRejectedValue(new ApiError(404, '文件不存在'))
    vi.spyOn(drafts, 'delete').mockResolvedValue(undefined)
    const creating = createNoteAt(path, '创建内容')
    const opening = openNote(path)
    if (succeeds) finish('r1')
    else fail(new ApiError(500, '创建写入失败'))
    expect(await creating).toBe(succeeds)
    await opening
    expect(ws.tabs.filter(tab => tab.path === path)).toHaveLength(succeeds ? 1 : 0)
    if (succeeds) {
      expect(ws.tabs.find(tab => tab.path === path)?.status).toBe('ready')
      expect(editorStateOf(path)?.doc.toString()).toBe('创建内容')
      await closeTab(path)
    } else {
      expect(toasts.some(toast => toast.text.includes('创建写入失败'))).toBe(true)
    }
    expect(toasts.some(toast => toast.text.includes('打开失败：文件不存在'))).toBe(false)
  })
})

describe('保存与关闭', () => {
  it('关闭冲突标签前持久化冲突之后的新输入，草稿失败时保留标签', async () => {
    const v = await edit('conflict.md')
    vi.spyOn(filesApi, 'writeFileApi').mockRejectedValue(new ApiError(412, '版本冲突', { rev: 'r2' }))
    const saved = new Map<string, Draft>()
    const put = vi.spyOn(drafts, 'put').mockImplementation(async (draft) => {
      saved.set(draft.path, draft); return draft.path
    })
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '冲突前' } })
    await flush('conflict.md')
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '冲突后新增' } })
    put.mockRejectedValueOnce(new Error('存储失败'))
    expect(await closeTab('conflict.md')).toBe(false)
    expect(ws.tabs.some(tab => tab.path === 'conflict.md')).toBe(true)
    expect(await closeTab('conflict.md')).toBe(true)
    expect(saved.get('conflict.md')?.content).toBe('冲突后新增')
    expect(editorStateOf('conflict.md')).toBeUndefined()
  })

  it('冲突保存期间的新输入继续保存，不能标成已保存', async () => {
    const v = await edit('race.md')
    vi.spyOn(drafts, 'put').mockImplementation(async draft => draft.path)
    const contents: string[] = []
    let finish!: (rev: string) => void
    vi.spyOn(filesApi, 'writeFileApi').mockImplementation(async ({ path: _path, content }) => {
      contents.push(content)
      return apiSuccess({ rev: await (contents.length === 1
        ? new Promise<string>((resolve) => {
            finish = resolve
          })
        : 'r3') })
    })
    const tab = ws.tabs.find(tab => tab.path === 'race.md')!
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
    vi.spyOn(drafts, 'put').mockImplementation(async draft => draft.path)
    const contents = new Map<string, string>()
    vi.spyOn(filesApi, 'writeFileApi').mockImplementation(async ({ path, content }) => {
      contents.set(path, content); return apiSuccess({ rev: await ('r2') })
    })
    let finish!: (link: string) => void
    vi.spyOn(assetsApi, 'importImageApi').mockImplementation(() => (new Promise<string>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess({ link: value })))
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
    vi.spyOn(drafts, 'put').mockImplementation(async draft => draft.path)
    const contents = new Map<string, string>()
    vi.spyOn(filesApi, 'writeFileApi').mockImplementation(async ({ path, content }) => {
      contents.set(path, content); return apiSuccess({ rev: await ('r2') })
    })
    let finish!: (link: string) => void
    vi.spyOn(assetsApi, 'uploadImageApi').mockImplementation(() => (new Promise<string>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess({ link: value })))
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
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'upload/note.md', dir: false, size: 0, mtime: 0 }] }))
    vi.spyOn(drafts, 'put').mockImplementation(async draft => draft.path)
    vi.spyOn(filesApi, 'writeFileApi').mockResolvedValue(apiSuccess({ rev: 'r2' }))
    const moving = vi.spyOn(filesApi, 'moveFileApi').mockResolvedValue(apiSuccess(new Response()))
    let finish!: (link: string) => void
    vi.spyOn(assetsApi, 'uploadImageApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof assetsApi.uploadImageApi>>['data']['link']>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess({ link: value })))
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
    vi.spyOn(filesApi, 'moveFileApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof filesApi.moveFileApi>>['data']>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess(value)))
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'moved.md', dir: false, size: 0, mtime: 0 }] }))
    const upload = vi.spyOn(assetsApi, 'uploadImageApi')
    const importing = vi.spyOn(assetsApi, 'importImageApi')
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
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'draft-move.md', dir: false, size: 0, mtime: 0 }] }))
    const moving = vi.spyOn(filesApi, 'moveFileApi').mockRejectedValue(new ApiError(500, '移动失败'))
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
    vi.spyOn(filesApi, 'importNotesApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof filesApi.importNotesApi>>['data']>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess(value)))
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: '导入', dir: true, size: 0, mtime: 0 }] }))
    const importing = importNotes('', '导入', [new File(['正文'], 'test.md')])
    expect(readyToReload()).toBe(false)
    finish(result)
    expect(await importing).toEqual(result)
    expect(ws.entries.some(e => e.path === '导入')).toBe(true)
    expect(readyToReload()).toBe(true)
    vi.mocked(filesApi.importNotesApi).mockResolvedValueOnce(apiSuccess(result))
    vi.mocked(treeApi.getTreeApi).mockRejectedValueOnce(new ApiError(500, '目录读取失败'))
    expect(await importNotes('', '导入', [])).toEqual(result)
    expect(toasts.some(t => t.text.includes('导入已完成，目录刷新失败'))).toBe(true)
  })

  it('失败保留错误并释放操作占用', async () => {
    ws.tabs = []
    vi.spyOn(filesApi, 'importNotesApi').mockRejectedValue(new ApiError(409, '目标已存在'))
    await expect(importNotes('', '导入', [])).rejects.toMatchObject({ status: 409, message: '目标已存在' })
    expect(readyToReload()).toBe(true)
  })
})

describe('图片管理', () => {
  it('替换期间阻止刷新，完成后更新列表；刷新失败不伪装成替换失败', async () => {
    ws.tabs = []
    let finish!: (value: Response) => void
    vi.spyOn(assetsApi, 'replaceImageApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof assetsApi.replaceImageApi>>['data']>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess(value)))
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'assets/a.png', dir: false, size: 2, mtime: 2 }] }))
    const replacing = replaceImage('assets/a.png', new File(['image'], 'a.png'))
    expect(readyToReload()).toBe(false)
    finish(new Response())
    await replacing
    expect(ws.entries.find(e => e.path === 'assets/a.png')?.mtime).toBe(2)
    expect(readyToReload()).toBe(true)
    vi.mocked(assetsApi.replaceImageApi).mockResolvedValueOnce(apiSuccess(new Response()))
    vi.mocked(treeApi.getTreeApi).mockRejectedValueOnce(new ApiError(500, '读取失败'))
    await replaceImage('assets/a.png', new File(['image'], 'a.png'))
    expect(toasts.some(t => t.text.includes('图片已替换，但刷新目录失败'))).toBe(true)
  })

  it('恢复图片只打开预览，不创建 Markdown 标签', async () => {
    ws.tabs = []
    ws.active = null
    vi.spyOn(trashApi, 'restoreTrashApi').mockResolvedValue(apiSuccess({ id: 'trash-image', path: 'assets/a.png', dir: false, deletedAt: 1 }))
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'assets/a.png', dir: false, size: 2, mtime: 2 }] }))
    await restore('trash-image')
    expect(ws.image).toBe('assets/a.png')
    expect(ws.tabs).toEqual([])
    expect(ws.active).toBeNull()
  })
})

describe('文件操作的保存前提', () => {
  it.each(['move', 'delete'] as const)('%s 保存失败时返回失败并保留原文档', async (action) => {
    const path = `保存失败-${action}.md`
    const v = await edit(path)
    vi.spyOn(drafts, 'put').mockImplementation(async draft => draft.path)
    const saving = vi.spyOn(filesApi, 'writeFileApi').mockRejectedValue(new ApiError(403, '禁止写入'))
    vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path, dir: false, size: 0, mtime: 0 }] }))
    v.dispatch({ changes: { from: 0, insert: '未保存' } })
    const result = action === 'move' ? await move(path, '目标.md') : await remove(path)
    expect(result.ok).toBe(false)
    expect(ws.active).toBe(path)
    expect(editorStateOf(path)?.doc.toString()).toBe('未保存原文')
    saving.mockResolvedValue(apiSuccess({ rev: 'r2' }))
    await flush(path)
    await refreshTree()
    await closeTab(path)
  })
})

vi.mock('@@/utils/resource-tickets', () => ({
  prepareResources: async () => {},
  imageResourceRoot: () => '/api/v1/resources/test-images/images/',
  fontResourceRoot: () => '/api/v1/resources/test-fonts/fonts/',
  pluginResourceURL: async (id: string, revision: string) => `/api/v1/resources/test-plugin/plugin/plugins/${id}/assets/${revision}/main.js`,
}))

it('失效会话的保存结果不覆盖重新登录后的标签页，也不安排旧内容重试', async () => {
  const { pinia } = await import('@/pinia')
  const { useUserStore } = await import('@/pinia/stores/user')
  const user = useUserStore(pinia)
  vi.spyOn(drafts, 'put').mockResolvedValue('session.md')
  const v = await edit('session.md')
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: '旧会话输入' } })
  let finish!: (rev: string) => void
  const write = vi.spyOn(filesApi, 'writeFileApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof filesApi.writeFileApi>>['data']['rev']>((resolve) => {
    finish = resolve
  })).then(value => apiSuccess({ rev: value })))
  const saved = flush('session.md')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  user.setToken('rms_new')
  stopWorkspace()
  view?.destroy(); view = undefined
  vi.mocked(noteFiles.readNoteFile).mockResolvedValue({ content: '新会话正文', rev: 'new-rev' })
  await openNote('session.md')
  finish('old-rev')
  await saved
  expect(ws.tabs.find(tab => tab.path === 'session.md')?.rev).toBe('new-rev')
  expect(editorStateOf('session.md')?.doc.toString()).toBe('新会话正文')
  expect(write).toHaveBeenCalledTimes(1)
  await closeTab('session.md')
  user.setToken('')
})

it('切换会话后新目录读取不等待已取消的旧目录请求', async () => {
  const user = useUserStore(pinia)
  let finish!: (entries: []) => void
  const tree = vi.spyOn(treeApi, 'getTreeApi').mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof treeApi.getTreeApi>>['data']['entries']>((resolve) => {
    finish = resolve
  })).then(value => apiSuccess({ entries: value }))).mockResolvedValue(apiSuccess({ entries: [{ path: 'new.md', dir: false, size: 0, mtime: 0 }] }))
  const previous = refreshTree().catch(error => error)
  await vi.waitFor(() => expect(tree).toHaveBeenCalledTimes(1))
  user.setToken('rms_new')
  stopWorkspace()
  const current = refreshTree().catch(error => error)
  try {
    expect(isCancel(await previous)).toBe(true)
    finish([])
    await vi.waitFor(() => expect(tree).toHaveBeenCalledTimes(2))
    expect(await current).toBeUndefined()
    expect(ws.entries.map(entry => entry.path)).toEqual(['new.md'])
  } finally {
    stopWorkspace(); await current; user.setToken('')
  }
})

it('新工作区不继承旧会话未完成的文件操作计数', async () => {
  const user = useUserStore(pinia)
  let cancel!: (error: Error) => void
  vi.spyOn(filesApi, 'writeFileApi').mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof filesApi.writeFileApi>>['data']['rev']>((_resolve, reject) => {
    cancel = reject
  })).then(value => apiSuccess({ rev: value })))
  const creating = createNoteAt('old.md')
  user.setToken('rms_new')
  stopWorkspace()
  const tree = vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'new.md', dir: false, size: 0, mtime: 0 }] }))
  const current = refreshTree().catch(error => error)
  try {
    await vi.waitFor(() => expect(tree).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(ws.entries.map(entry => entry.path)).toEqual(['new.md']))
  } finally {
    cancel(new CanceledError('旧会话已关闭'))
    await creating
    stopWorkspace(); await current; user.setToken('')
  }
})

it('外部移动事件等待草稿后换会话，不再映射新工作区的同名笔记', async () => {
  const user = useUserStore(pinia)
  vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [{ path: 'from/note.md', dir: false, size: 0, mtime: 0 }] }))
  vi.spyOn(settingsApi, 'getSettingsApi').mockResolvedValue(apiSuccess({}))
  vi.spyOn(fontsApi, 'getFontsApi').mockResolvedValue(apiSuccess({ fonts: [] }))
  vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] }))
  vi.spyOn(drafts, 'all').mockResolvedValue([])
  await startWorkspace()
  await edit('from/note.md')
  let finish!: () => void
  let completed = false
  vi.mocked(drafts.move).mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    completed = true
  })
  vi.mocked(connectEventsApi).mock.lastCall![0].onEvents([{ type: 'moved', from: 'from', path: 'to' }])
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  user.setToken('rms_new')
  stopWorkspace()
  view?.destroy(); view = undefined
  vi.mocked(noteFiles.readNoteFile).mockResolvedValue({ content: '新会话正文', rev: 'new-rev' })
  await openNote('from/note.md')
  finish()
  await vi.waitFor(() => expect(completed).toBe(true))
  expect(ws.active).toBe('from/note.md')
  expect(editorStateOf('from/note.md')?.doc.toString()).toBe('新会话正文')
  expect(editorStateOf('to/note.md')).toBeUndefined()
  user.setToken('')
})

it('旧网页粘贴在换会话后不继续下载下一批图片或修改同名笔记', async () => {
  const user = useUserStore(pinia)
  const v = await edit('paste-session.md')
  const finish: ((link: string) => void)[] = []
  const importing = vi.spyOn(assetsApi, 'importImageApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof assetsApi.importImageApi>>['data']['link']>((resolve) => {
    finish.push(resolve)
  })).then(value => apiSuccess({ link: value })))
  const data = new DataTransfer()
  data.setData('text/html', Array.from({ length: 4 }, (_, i) => `<img src="https://example.com/${i}.png">`).join(''))
  data.setData('text/plain', '剪贴板内容')
  v.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(importing).toHaveBeenCalledTimes(3))
  user.setToken('rms_new')
  stopWorkspace()
  view?.destroy(); view = undefined
  vi.mocked(noteFiles.readNoteFile).mockResolvedValue({ content: '新会话正文', rev: 'new-rev' })
  await openNote('paste-session.md')
  toasts.splice(0)
  finish.forEach(resolve => resolve('./assets/old.png'))
  await flushPromises()
  expect(importing).toHaveBeenCalledTimes(3)
  expect(editorStateOf('paste-session.md')?.doc.toString()).toBe('新会话正文')
  expect(toasts).toHaveLength(0)
  expect(readyToReload()).toBe(true)
  user.setToken('')
})

it('工作区关闭后不响应其全局新建快捷键', async () => {
  vi.spyOn(treeApi, 'getTreeApi').mockResolvedValue(apiSuccess({ entries: [] }))
  vi.spyOn(settingsApi, 'getSettingsApi').mockResolvedValue(apiSuccess({}))
  vi.spyOn(fontsApi, 'getFontsApi').mockResolvedValue(apiSuccess({ fonts: [] }))
  vi.spyOn(pluginsApi, 'getPluginsApi').mockResolvedValue(apiSuccess({ plugins: [] }))
  vi.spyOn(drafts, 'all').mockResolvedValue([])
  const write = vi.spyOn(filesApi, 'writeFileApi').mockResolvedValue(apiSuccess({ rev: 'unused' }))
  await startWorkspace()
  stopWorkspace()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true }))
  expect(write).not.toHaveBeenCalled()
  expect(ws.tabs).toEqual([])
})

it('弹窗接管移动错误时只返回失败，由调用方展示；目录操作仍保留默认提示', async () => {
  toasts.splice(0)
  ws.entries = [{ path: 'already.md', dir: false, size: 0, mtime: 0 }]
  const result = await move('source.md', 'already.md', 'caller')
  expect(result).toEqual({ ok: false, error: '“already.md”已存在' })
  expect(toasts).toHaveLength(0)
  await move('source.md', 'already.md')
  expect(toasts.map(item => item.text)).toEqual(['“already.md”已存在'])
})
