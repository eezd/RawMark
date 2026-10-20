import { EditorView, WidgetType } from '@codemirror/view'
import { emojiFor, renderMath, renderMermaid } from '../markdown/render'

export class BulletWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-rm-bullet'
    el.textContent = '•'
    return el
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked
  }
  toDOM(view: EditorView) {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.className = 'cm-rm-task'
    el.checked = this.checked
    // 用 mousedown 并阻止默认行为：否则编辑器先移动光标，行被展开为源码，点击落空
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(el)
      const marker = view.state.sliceDoc(pos, pos + 3)
      if (!/^\[[ xX]\]$/.test(marker)) return
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.checked ? ' ' : 'x' } })
    })
    return el
  }
  ignoreEvent() {
    return true
  }
}

export class HorizontalRuleWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-rm-hr'
    return el
  }
}

// 写入剪贴板；Clipboard API 只在 HTTPS/localhost 可用，局域网 HTTP 访问时退回 execCommand
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 权限被拒时继续尝试旧方法
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.append(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  return ok
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

// 代码块右上角：语言标签（未激活时）+ 复制按钮
export class CodeHeaderWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly showLang: boolean,
    // 根据组件所在位置取出代码块内容，由调用方结合语法树实现
    readonly codeAt: (view: EditorView, pos: number) => string | null,
  ) {
    super()
  }
  eq(other: CodeHeaderWidget) {
    return other.lang === this.lang && other.showLang === this.showLang
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span')
    el.className = 'cm-rm-code-header'
    if (this.showLang && this.lang) {
      const label = document.createElement('span')
      label.className = 'cm-rm-code-lang'
      label.textContent = this.lang
      el.append(label)
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'cm-rm-code-copy'
    btn.title = '复制代码'
    btn.innerHTML = COPY_ICON
    btn.addEventListener('mousedown', (e) => e.preventDefault())
    btn.addEventListener('click', async () => {
      const code = this.codeAt(view, view.posAtDOM(el))
      if (code === null || !(await copyText(code))) return
      btn.innerHTML = CHECK_ICON
      btn.classList.add('cm-rm-copied')
      setTimeout(() => {
        btn.innerHTML = COPY_ICON
        btn.classList.remove('cm-rm-copied')
      }, 1500)
    })
    el.append(btn)
    return el
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super()
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-rm-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    img.decoding = 'async'
    // 图片加载完成后高度变化，需通知编辑器重新测量，否则光标定位会错位
    img.addEventListener('load', () => view.requestMeasure())
    // 组件内的事件默认被编辑器忽略，需手动把光标移到图片语法处以展开源码
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // 先设光标再聚焦：focus() 会把编辑器选区写回 DOM，反之会读到残留在别处（如表格单元格）的 DOM 选区
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } })
      view.focus()
    })
    img.addEventListener('error', () => {
      wrap.classList.add('cm-rm-image-error')
      wrap.textContent = this.alt || this.src
    })
    wrap.append(img)
    return wrap
  }
  get estimatedHeight() {
    return 200
  }
}

// ---- 扩展语法（公式、Mermaid、emoji、脚注、目录） ----

// 点击渲染结果时把光标移到源码中（offset 为相对组件起点的位置）以展开编辑，做法同图片
function editOnMousedown(el: HTMLElement, view: EditorView, offset: number) {
  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    view.dispatch({ selection: { anchor: Math.min(view.posAtDOM(el) + offset, view.state.doc.length) } })
    view.focus()
  })
}

function showRenderError(el: HTMLElement, err: unknown) {
  const pre = document.createElement('pre')
  pre.className = 'cm-rm-render-error'
  pre.textContent = err instanceof Error ? err.message : String(err)
  el.replaceChildren(pre)
}

/**
 * 公式。editOffset 为 null 时是编辑中显示在源码下方的预览（不响应点击，内容变化时原地更新），
 * 否则是替换源码的渲染结果，点击后光标移到源码 editOffset 处
 */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly editOffset: number | null,
  ) {
    super()
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.editOffset === this.editOffset
  }
  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-rm-math-block' : 'cm-rm-math'
    if (this.editOffset === null) el.classList.add('cm-rm-preview')
    else editOnMousedown(el, view, this.editOffset)
    this.render(el, view)
    return el
  }
  // 只复用预览元素：从渲染结果切到编辑时，编辑器会尝试用新组件更新旧元素（旧元素带点击编辑的监听）
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (this.editOffset !== null || !dom.classList.contains('cm-rm-preview')) return false
    this.render(dom, view)
    return true
  }
  private render(el: HTMLElement, view: EditorView) {
    if (!this.tex.trim()) {
      el.textContent = '空公式'
      el.classList.add('cm-rm-placeholder')
      return
    }
    el.classList.remove('cm-rm-placeholder')
    // 加载 KaTeX 前先显示源码
    if (!el.firstChild) el.textContent = this.tex
    void renderMath(el, this.tex, this.display).then(() => view.requestMeasure())
  }
  get estimatedHeight() {
    return this.display ? 60 : -1
  }
}

const mermaidSeqs = new WeakMap<HTMLElement, number>()
const mermaidListeners = new WeakMap<HTMLElement, () => void>()
let mermaidSeq = 0

/** Mermaid 图表，editOffset 含义同 MathWidget */
export class MermaidWidget extends WidgetType {
  constructor(
    readonly code: string,
    readonly editOffset: number | null,
  ) {
    super()
  }
  eq(other: MermaidWidget) {
    return other.code === this.code && other.editOffset === this.editOffset
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-rm-mermaid'
    if (this.editOffset === null) el.classList.add('cm-rm-preview')
    else editOnMousedown(el, view, this.editOffset)
    el.textContent = '图表渲染中…'
    this.render(el, view)
    const update = () => this.render(el, view)
    mermaidListeners.set(el, update)
    window.addEventListener('rawmark-appearance', update)
    return el
  }
  // 只复用预览元素：从渲染结果切到编辑时，编辑器会尝试用新组件更新旧元素（旧元素带点击编辑的监听）
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (this.editOffset !== null || !dom.classList.contains('cm-rm-preview')) return false
    this.render(dom, view)
    const old = mermaidListeners.get(dom)
    if (old) window.removeEventListener('rawmark-appearance', old)
    const update = () => this.render(dom, view)
    mermaidListeners.set(dom, update)
    window.addEventListener('rawmark-appearance', update)
    return true
  }
  destroy(dom: HTMLElement) {
    const update = mermaidListeners.get(dom)
    if (update) window.removeEventListener('rawmark-appearance', update)
    mermaidListeners.delete(dom)
    mermaidSeqs.delete(dom)
  }
  // 渲染是异步的，连续输入时只采用最后一次的结果，并保留旧图直到新图就绪，避免闪烁
  private render(el: HTMLElement, view: EditorView) {
    const seq = ++mermaidSeq
    mermaidSeqs.set(el, seq)
    if (!this.code.trim()) {
      el.textContent = '空图表'
      return
    }
    renderMermaid(this.code).then(
      (svg) => {
        if (mermaidSeqs.get(el) !== seq) return
        el.innerHTML = svg
        view.requestMeasure()
      },
      (err) => {
        if (mermaidSeqs.get(el) !== seq) return
        showRenderError(el, err)
        view.requestMeasure()
      },
    )
  }
  get estimatedHeight() {
    return 240
  }
}

export class EmojiWidget extends WidgetType {
  constructor(readonly name: string) {
    super()
  }
  eq(other: EmojiWidget) {
    return other.name === this.name
  }
  toDOM(view: EditorView) {
    const el = document.createElement('span')
    el.className = 'cm-rm-emoji'
    // 名称表加载前或名称未知时显示原文
    el.textContent = `:${this.name}:`
    void emojiFor(this.name).then((e) => {
      if (e) el.textContent = e
    })
    editOnMousedown(el, view, 1)
    return el
  }
}

export class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly definition: string | undefined,
  ) {
    super()
  }
  eq(other: FootnoteRefWidget) {
    return other.label === this.label && other.definition === this.definition
  }
  toDOM(view: EditorView) {
    const el = document.createElement('sup')
    el.className = 'cm-rm-footnote-ref'
    el.textContent = this.label
    el.title = this.definition ?? '未找到脚注定义'
    editOnMousedown(el, view, 2)
    return el
  }
}

export interface TocEntry {
  level: number
  text: string
  pos: number
}

export class TocWidget extends WidgetType {
  constructor(readonly entries: TocEntry[]) {
    super()
  }
  eq(other: TocWidget) {
    return JSON.stringify(other.entries) === JSON.stringify(this.entries)
  }
  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-rm-toc'
    if (!this.entries.length) {
      el.textContent = '目录（还没有标题）'
      el.classList.add('cm-rm-placeholder')
    }
    const minLevel = Math.min(...this.entries.map((e) => e.level))
    for (const entry of this.entries) {
      const item = document.createElement('a')
      item.className = 'cm-rm-toc-item'
      item.style.paddingLeft = `${(entry.level - minLevel) * 1.2}em`
      item.textContent = entry.text
      item.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        view.dispatch({ selection: { anchor: entry.pos }, effects: EditorView.scrollIntoView(entry.pos, { y: 'start', yMargin: 24 }) })
        view.focus()
      })
      el.append(item)
    }
    // 点击目录空白处展开 [TOC] 源码
    editOnMousedown(el, view, 0)
    return el
  }
}
