// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { htmlToMarkdown } from './html-paste'
import { pasteImages } from './paste'

let view: EditorView | undefined
afterEach(() => { view?.destroy(); view = undefined; vi.restoreAllMocks() })

function paste(html: string, text: string) {
  const data = new DataTransfer()
  data.setData('text/html', html)
  data.setData('text/plain', text)
  view!.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
}

function editor(importImage: (url: string) => Promise<string> = async () => { throw new Error('此用例不下载图片') }) {
  let pending = 0
  const errors: unknown[] = []
  view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '', extensions: [history(), pasteImages({
    upload: async () => { throw new Error('此用例不上传文件') },
    importImage,
    update: (change) => { const spec = change(view!.state); if (spec) view!.dispatch(spec) },
    onError: (error) => errors.push(error),
    onPending: (delta) => { pending += delta },
  })] }) })
  return { pending: () => pending, errors }
}

describe('网页粘贴', () => {
  it('保留标题、列表、链接、代码块、删除线和表格，并移除活动内容', async () => {
    const result = await htmlToMarkdown('<h2>标题</h2><ul><li>一</li><li><del>二</del></li></ul><a href="https://example.com/a(b)">链接</a><pre><code class="language-js">const x = 1\n</code></pre><table><tr><th>名称</th><th>值</th></tr><tr><td><strong>甲</strong></td><td>a|b</td></tr></table><script>alert(1)</script><style>body{}</style><a href="java&#9;script:alert(1)">危险链接</a>', async () => '', () => {})
    expect(result).toContain('## 标题')
    expect(result).toMatch(/-\s+一/)
    expect(result).toContain('~~二~~')
    expect(result).toContain('[链接](<https://example.com/a(b)>)')
    expect(result).toContain('```js\nconst x = 1\n```')
    expect(result).toContain('| 名称 | 值 |\n| --- | --- |\n| **甲** | a\\|b |')
    expect(result).not.toContain('alert(1)')
    expect(result).not.toContain('body{}')
    expect(result).toContain('危险链接')
  })

  it('相同来源只下载一次，失败保留原图链接并报告原始原因', async () => {
    const failure = new Error('来源拒绝下载')
    const errors: unknown[] = []
    const urls: string[] = []
    const result = await htmlToMarkdown('<base href="https://example.com/docs/"><img alt="图" src="../a.png"><img src="//example.com/a.png"><img src="bad.png">', async (url) => {
      urls.push(url)
      if (url.endsWith('bad.png')) throw failure
      return '笔记.assets/hash.png'
    }, (error) => errors.push(error))
    expect(urls.sort()).toEqual(['https://example.com/a.png', 'https://example.com/docs/bad.png'])
    expect(result.match(/笔记.assets\/hash.png/g)).toHaveLength(2)
    expect(result).toContain('https://example.com/docs/bad.png')
    expect(errors).toEqual([failure])
  })

  it('转换期间的新输入保持原样，撤销一次移除转换后的整次粘贴', async () => {
    const state = editor()
    paste('<h1>标题</h1>', '标题')
    view!.dispatch({ changes: { from: 0, insert: '之后输入' }, userEvent: 'input.type' })
    await vi.waitFor(() => expect(state.pending()).toBe(0))
    expect(view!.state.doc.toString()).toBe('# 标题之后输入')
    undo(view!)
    expect(view!.state.doc.toString()).toBe('之后输入')
    undo(view!)
    expect(view!.state.doc.toString()).toBe('')
    expect(state.errors).toEqual([])
  })

  it('用户已修改粘贴区域时不覆盖新输入，Shift 粘贴保持纯文本', async () => {
    const state = editor()
    view!.dispatch({ changes: { from: 0, insert: '原选区' }, selection: { anchor: 0, head: 3 } })
    paste('<h1>标题</h1>', '标题')
    view!.dispatch({ changes: { from: 1, to: 3, insert: '新输入' } })
    await vi.waitFor(() => expect(state.pending()).toBe(0))
    expect(view!.state.doc.toString()).toBe('原新输入')
    view!.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', shiftKey: true, ctrlKey: true, bubbles: true }))
    paste('<h1>纯文本</h1>', '纯文本')
    expect(view!.state.doc.toString()).not.toContain('#')
    expect(view!.state.doc.toString()).toContain('纯文本')
    expect(state.pending()).toBe(0)
  })

  it('同一位置连续发起的异步粘贴保持发起顺序', async () => {
    const state = editor()
    paste('<b>第一段</b>', '第一段')
    paste('<b>第二段</b>', '第二段')
    await vi.waitFor(() => expect(state.pending()).toBe(0))
    expect(view!.state.doc.toString()).toBe('**第一段****第二段**')
  })

  it('后发粘贴的图片先完成时仍保持顺序，撤销会取消尚未插入的粘贴', async () => {
    const downloads = new Map<string, (link: string) => void>()
    const state = editor((url) => new Promise((resolve) => downloads.set(url, resolve)))
    paste('<b>第一段</b><img src="https://example.com/1.png">', '第一段')
    paste('<b>第二段</b><img src="https://example.com/2.png">', '第二段')
    await vi.waitFor(() => expect(downloads.size).toBe(2))
    downloads.get('https://example.com/2.png')!('n.assets/2.png')
    await vi.waitFor(() => expect(view!.state.doc.toString()).toContain('第二段'))
    downloads.get('https://example.com/1.png')!('n.assets/1.png')
    await vi.waitFor(() => expect(state.pending()).toBe(0))
    expect(view!.state.doc.toString().indexOf('第一段')).toBeLessThan(view!.state.doc.toString().indexOf('第二段'))
    paste('<b>取消的粘贴</b><img src="https://example.com/3.png">', '取消的粘贴')
    await vi.waitFor(() => expect(downloads.size).toBe(3))
    undo(view!)
    downloads.get('https://example.com/3.png')!('n.assets/3.png')
    await vi.waitFor(() => expect(state.pending()).toBe(0))
    expect(view!.state.doc.toString()).not.toContain('取消的粘贴')
  })
})
