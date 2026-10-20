// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { insertImageFiles } from '../editor/paste'
import { api, ApiError } from './api'
import { drafts, type Draft } from './drafts'
import { attachView, closeTab, editorStateOf, flush, keepLocalVersion, openNote, ws } from './workspace'

let view: EditorView | undefined
afterEach(() => {
  attachView(null)
  view?.destroy()
  view = undefined
  vi.restoreAllMocks()
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
})
