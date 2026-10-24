// @vitest-environment happy-dom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Sidebar from './Sidebar.vue'
import { expanded } from './tree'
import * as workspace from './workspace'

let app: App
let host: HTMLElement
beforeEach(async () => {
  vi.spyOn(workspace, 'move').mockResolvedValue({ ok: true })
  Object.assign(workspace.ws, { searchOpen: false, active: '', image: null, renaming: null, entries: [
    { path: 'source', dir: true }, { path: 'source/source-note.md', dir: false },
    { path: 'target', dir: true }, { path: 'target/existing-note.md', dir: false },
    { path: 'target/nested', dir: true }, { path: 'target/nested/child-note.md', dir: false },
    { path: 'root-note.md', dir: false },
  ].map(entry => ({ ...entry, size: 0, mtime: 0 })) })
  expanded.clear()
  for (const dir of ['source', 'target', 'target/nested']) expanded.add(dir)
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(Sidebar)
  app.mount(host)
  await nextTick()
})
afterEach(() => {
  app.unmount()
  host.remove()
  vi.restoreAllMocks()
})

function row(name: string): HTMLElement {
  const node = [...host.querySelectorAll<HTMLElement>('.rm-tree-row')].find(row => row.querySelector('.rm-tree-name')?.textContent === name)
  if (!node) throw new Error('找不到目录项：' + name)
  return node
}

function drag(target: Element | Window, type: string, source = 'source/source-note.md', relatedTarget: EventTarget | null = null, internal = true) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: { types: [internal ? 'application/x-rawmark-path' : 'text/plain'], getData: () => source } },
    relatedTarget: { value: relatedTarget },
  })
  target.dispatchEvent(event)
  return event
}

describe('目录树拖放目标', () => {
  it.each(['', '.rm-tree-name', '.rm-tree-more'])('文件行落点 %s 接收至所在文件夹，不能冒泡到根目录', selector => {
    const target = row('existing-note')
    drag(selector ? target.querySelector(selector)! : target, 'drop')
    expect(workspace.move).toHaveBeenCalledExactlyOnceWith('source/source-note.md', 'target/source-note.md')
  })

  it.each(['', '.rm-tree-name', 'svg'])('文件夹行落点 %s 接收至该文件夹', selector => {
    const target = row('target')
    drag(selector ? target.querySelector(selector)! : target, 'drop')
    expect(workspace.move).toHaveBeenCalledExactlyOnceWith('source/source-note.md', 'target/source-note.md')
  })

  it('深层文件使用直接父目录', () => {
    drag(row('child-note'), 'drop')
    expect(workspace.move).toHaveBeenCalledExactlyOnceWith('source/source-note.md', 'target/nested/source-note.md')
  })

  it.each(['root-note', 'blank'])('根目标 %s 只移动一次', target => {
    drag(target === 'blank' ? host.querySelector('.rm-tree')! : row(target), 'drop')
    expect(workspace.move).toHaveBeenCalledExactlyOnceWith('source/source-note.md', 'source-note.md')
  })

  it.each([
    ['existing-note', 'target/existing-note.md'],
    ['target', 'target/existing-note.md'],
    ['target', 'target'],
    ['nested', 'target'],
    ['child-note', 'target'],
  ])('无效移动 %s / %s 不得冒泡后改成移动到根目录', (target, source) => {
    const event = drag(row(target), 'drop', source)
    expect(event.defaultPrevented).toBe(true)
    expect(workspace.move).not.toHaveBeenCalled()
  })

  it('属于节点的列表留白不能交给根目录接收', () => {
    drag(row('target').parentElement!.querySelector('ul')!, 'drop')
    expect(workspace.move).not.toHaveBeenCalled()
  })

  it('悬停文件只高亮直接父目录，进入根空白后切换为根区域提示', async () => {
    drag(row('child-note').querySelector('.rm-tree-name')!, 'dragover')
    await nextTick()
    expect(row('nested').classList.contains('drop')).toBe(true)
    expect(row('child-note').classList.contains('drop')).toBe(false)
    expect(host.querySelector('.rm-tree')!.classList.contains('drop')).toBe(false)
    drag(host.querySelector('.rm-tree')!, 'dragover')
    await nextTick()
    expect(host.querySelectorAll('.rm-tree-row.drop')).toHaveLength(0)
    expect(host.querySelector('.rm-tree')!.classList.contains('drop')).toBe(true)
  })

  it('离开树之前在行内切换子元素不会清除目标', async () => {
    const target = row('existing-note')
    drag(target, 'dragover')
    drag(target.querySelector('.rm-tree-name')!, 'dragleave', undefined, target.querySelector('.rm-tree-more'))
    await nextTick()
    expect(row('target').classList.contains('drop')).toBe(true)
    drag(target, 'dragleave', undefined, document.body)
    await nextTick()
    expect(host.querySelectorAll('.drop')).toHaveLength(0)
  })

  it.each(['dragend', 'blur', 'Escape', 'drop'])('结束或取消 %s 后清除所有高亮', async type => {
    drag(row('existing-note'), 'dragover')
    await nextTick()
    expect(host.querySelector('.drop')).not.toBeNull()
    if (type === 'Escape') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    else if (type === 'drop') drag(row('existing-note'), 'drop')
    else window.dispatchEvent(new Event(type))
    await nextTick()
    expect(host.querySelectorAll('.drop')).toHaveLength(0)
  })

  it('不接管外部文本拖放，空的内部载荷也不得移动文件', () => {
    expect(drag(row('existing-note'), 'dragover', '', null, false).defaultPrevented).toBe(false)
    drag(row('existing-note'), 'drop', '', null, false)
    drag(row('existing-note'), 'drop', '')
    expect(workspace.move).not.toHaveBeenCalled()
  })
})
