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

export class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }
  eq(other: CodeLangWidget) {
    return other.lang === this.lang
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-rm-code-lang'
    el.textContent = this.lang
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
