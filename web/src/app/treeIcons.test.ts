// @vitest-environment happy-dom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar.vue'
import { expanded, selectedPaths, treeIconTarget } from './tree'
import * as workspace from './workspace'
import { api } from './api'

let app: App
let host: HTMLElement
beforeEach(async () => {
  vi.spyOn(workspace, 'saveTreeIcon').mockResolvedValue()
  vi.spyOn(workspace, 'openNote').mockResolvedValue()
  vi.spyOn(workspace, 'move').mockResolvedValue({ ok: true })
  localStorage.removeItem('rawmark.recent-tree-icons')
  Object.assign(workspace.ws, { searchOpen: false, active: '', image: null, renaming: null, entries: [
    { path: 'folder', dir: true }, { path: 'folder/a.md', dir: false },
    { path: 'folder/b.md', dir: false }, { path: 'folder/c.md', dir: false },
  ].map(e => ({ ...e, size: 0, mtime: 0 })) })
  expanded.clear()
  selectedPaths.clear()
  treeIconTarget.value = null
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(Sidebar)
  app.mount(host)
  await nextTick()
})
afterEach(() => { app.unmount(); host.remove(); vi.restoreAllMocks() })
const row = (name: string) => [...host.querySelectorAll<HTMLElement>('.rm-tree-row')].find(e => e.querySelector('.rm-tree-name')?.textContent === name)!
const click = async (element: Element, init: MouseEventInit = {}) => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init })); await nextTick() }
const button = (name: string) => document.querySelector<HTMLElement>(`[aria-label="${name}"]`)!
async function picker() {
  await click(row('folder').querySelector('.rm-tree-icon')!)
  await vi.waitFor(() => expect(button('搜索图标')).not.toBeNull())
}

describe('文件树图标操作', () => {
  it('保留右侧目录菜单，点击默认图标不折叠目录或改变多选', async () => {
    expect(host.querySelector('.rm-vault-heading .rm-tree-label')?.textContent).toBe('文件目录')
    expect(row('folder').querySelector('.rm-tree-icon')?.textContent?.trim()).toBe('📂')
    await click(row('folder'))
    expect(row('a').querySelector('.rm-tree-icon')?.textContent?.trim()).toBe('📄')
    await click(row('a'), { ctrlKey: true })
    const selected = [...selectedPaths]
    await picker()
    expect(expanded.has('folder')).toBe(true)
    expect([...selectedPaths]).toEqual(selected)
    expect(workspace.openNote).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(treeIconTarget.value).toBeNull()
    expect(document.activeElement).toBe(row('folder').querySelector('.rm-tree-icon'))
  })

  it('中文搜索表情并保存到当前节点，最近使用只记成功操作', async () => {
    await picker()
    const input = button('搜索图标') as HTMLInputElement
    input.value = '文件夹'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(button('文件夹 目录 打开')).not.toBeNull())
    await click(button('文件夹 目录 打开'))
    await vi.waitFor(() => expect(treeIconTarget.value).toBeNull())
    expect(workspace.saveTreeIcon).toHaveBeenCalledExactlyOnceWith('folder', { kind: 'emoji', value: '📂' })
    expect(JSON.parse(localStorage.getItem('rawmark.recent-tree-icons')!)).toEqual([{ kind: 'emoji', value: '📂' }])
  })

  it('保存失败保留弹窗与明确错误，恢复默认成功后关闭', async () => {
    vi.mocked(workspace.saveTreeIcon).mockRejectedValueOnce(new Error('磁盘只读'))
    await picker()
    await click([...document.querySelectorAll('button')].find(e => e.textContent === '恢复默认图标')!)
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('磁盘只读'))
    expect(treeIconTarget.value?.path).toBe('folder')
    expect(localStorage.getItem('rawmark.recent-tree-icons')).toBeNull()
    await click([...document.querySelectorAll('button')].find(e => e.textContent === '恢复默认图标')!)
    await vi.waitFor(() => expect(treeIconTarget.value).toBeNull())
    expect(workspace.saveTreeIcon).toHaveBeenLastCalledWith('folder', null)
  })

  it('线性图标可搜索，右键入口选择同一节点', async () => {
    row('folder').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await nextTick()
    await click([...document.querySelectorAll('.rm-tree-menu button')].find(e => e.textContent === '修改图标')!)
    await click([...document.querySelectorAll('[role="tab"]')].find(e => e.textContent === '线性图标')!)
    const input = button('搜索图标') as HTMLInputElement
    input.value = '任务'; input.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    expect(document.querySelectorAll('.rm-tree-icon-grid button')).toHaveLength(1)
    await click(button('任务'))
    expect(workspace.saveTreeIcon).toHaveBeenCalledWith('folder', { kind: 'builtin', value: 'task' })
  })

  it('Ctrl 和 Shift 仍按可见行选择，快速展开/收起保留最新状态', async () => {
    await click(row('folder'))
    await click(row('a'))
    await click(row('c'), { shiftKey: true })
    expect([...selectedPaths]).toEqual(['folder/a.md', 'folder/b.md', 'folder/c.md'])
    await click(row('b'), { ctrlKey: true })
    expect([...selectedPaths]).toEqual(['folder/a.md', 'folder/c.md'])
    await click(row('folder'))
    await click(row('folder'))
    await vi.waitFor(() => expect(row('c')).toBeDefined())
    expect(expanded.has('folder')).toBe(true)
    await click(row('folder'))
    await vi.waitFor(() => expect(row('a')).toBeUndefined())
    expect(selectedPaths.has('folder/a.md')).toBe(false)
  })

  it('从图标按住拖动仍使用整行的拖放契约，不能误开选择框', async () => {
    const setData = vi.fn()
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { setData, effectAllowed: '' } })
    row('folder').querySelector('.rm-tree-icon')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(setData).toHaveBeenCalledExactlyOnceWith('application/x-rawmark-path', 'folder')
    expect(treeIconTarget.value).toBeNull()
  })

  it('持久属性直接来自目录 API，不维护第二份图标映射', async () => {
    workspace.ws.entries[0].icon = { kind: 'builtin', value: 'task' }
    await nextTick()
    expect(row('folder').querySelector('.rm-tree-icon svg')).not.toBeNull()
    workspace.ws.entries[0].icon = { kind: 'emoji', value: '📚' }
    await nextTick()
    expect(row('folder').querySelector('.rm-tree-icon')?.textContent?.trim()).toBe('📚')
  })
})

it('图标请求沿用认证、禁缓存和 null 重置契约', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
  await api.setTreeIcon('folder/a.md', null)
  expect(fetch).toHaveBeenCalledWith('/api/v1/tree-icon', expect.objectContaining({ method: 'PUT', credentials: 'same-origin', cache: 'no-store', body: '{"path":"folder/a.md","icon":null}' }))
})
