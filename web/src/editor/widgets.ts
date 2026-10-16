import { WidgetType, type EditorView } from '@codemirror/view'

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
async function copyText(text: string): Promise<boolean> {
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
