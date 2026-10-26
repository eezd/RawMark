import type { OwnedRenderer } from '@@/plugins/registry'
import { locale, t as translate } from '@@/i18n/runtime'
import { emojiFor, renderMath } from '@@/markdown/render'
import { mountContent } from '@@/plugins/mount'
import { copyText } from '@@/utils/clipboard'
import { EditorView, WidgetType } from '@codemirror/view'

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
    // Use mousedown with preventDefault; otherwise the editor moves the cursor, expands the line to source, and loses the click.
    el.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(el)
      const marker = view.state.sliceDoc(pos, pos + 3)
      if (!/^\[[ x]\]$/i.test(marker)) return
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

const COPY_ICON
  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON
  = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'

// Code-block top right: language label when inactive, plus a copy button.
export class CodeHeaderWidget extends WidgetType {
  readonly locale = locale.value
  constructor(
    readonly lang: string,
    readonly showLang: boolean,
    // Read code contents at the widget position; the caller implements this using the syntax tree.
    readonly codeAt: (view: EditorView, pos: number) => string | null,
  ) {
    super()
  }

  eq(other: CodeHeaderWidget) {
    return other.locale === this.locale && other.lang === this.lang && other.showLang === this.showLang
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
    btn.title = translate('workspace.copy_code_420c20')
    btn.innerHTML = COPY_ICON
    btn.addEventListener('mousedown', e => e.preventDefault())
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
    // Image loading changes height; request editor remeasurement to keep cursor positioning correct.
    img.addEventListener('load', () => view.requestMeasure())
    // The editor ignores widget events by default; move the cursor to image syntax manually to expand source.
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault()
      // Set the cursor before focusing: focus() writes editor selection to the DOM; reversing this reads a stale DOM selection elsewhere, such as a table cell.
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

// ---- Extended syntax (math, Mermaid, emoji, footnotes, table of contents) ----

// Clicking rendered output moves the cursor into source at offset relative to the widget start, expanding editing as with images.
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
 * Math. A null editOffset means a preview below source during editing: no click handling, update in place
 * on content changes. Otherwise it replaces source; clicking moves the cursor to editOffset in the source.
 */
export class MathWidget extends WidgetType {
  readonly locale = locale.value
  constructor(
    readonly tex: string,
    readonly display: boolean,
    readonly editOffset: number | null,
  ) {
    super()
  }

  eq(other: MathWidget) {
    return other.locale === this.locale && other.tex === this.tex && other.display === this.display && other.editOffset === this.editOffset
  }

  toDOM(view: EditorView) {
    const el = document.createElement(this.display ? 'div' : 'span')
    el.className = this.display ? 'cm-rm-math-block' : 'cm-rm-math'
    if (this.editOffset === null) el.classList.add('cm-rm-preview')
    else editOnMousedown(el, view, this.editOffset)
    this.render(el, view)
    return el
  }

  // Reuse preview elements only: switching rendered output to editing may update an old element that still has click-to-edit listeners.
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (this.editOffset !== null || !dom.classList.contains('cm-rm-preview')) return false
    this.render(dom, view)
    return true
  }

  private render(el: HTMLElement, view: EditorView) {
    if (!this.tex.trim()) {
      el.textContent = translate('workspace.empty_formula_fd803b')
      el.classList.add('cm-rm-placeholder')
      return
    }
    el.classList.remove('cm-rm-placeholder')
    // Show source until KaTeX loads.
    if (!el.firstChild) el.textContent = this.tex
    void renderMath(el, this.tex, this.display).then(() => view.requestMeasure())
  }

  get estimatedHeight() {
    return this.display ? 60 : -1
  }
}

const rendererMounts = new WeakMap<HTMLElement, () => void>()

/** Generic code-block preview; editOffset follows the math widget's click-to-edit contract. */
export class CodeRendererWidget extends WidgetType {
  readonly locale = locale.value
  constructor(
    readonly code: string,
    readonly editOffset: number | null,
    readonly language: string,
    readonly path: string,
    readonly renderer: OwnedRenderer,
  ) {
    super()
  }

  eq(other: CodeRendererWidget) {
    return other.locale === this.locale && other.code === this.code && other.editOffset === this.editOffset && other.language === this.language && other.path === this.path && other.renderer === this.renderer
  }

  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = this.language === 'mermaid' ? 'cm-rm-mermaid' : 'cm-rm-code-render'
    if (this.editOffset === null) el.classList.add('cm-rm-preview')
    else editOnMousedown(el, view, this.editOffset)
    this.mount(el, view)
    return el
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    if (this.editOffset !== null || !dom.classList.contains('cm-rm-preview')) return false
    dom.className = `${this.language === 'mermaid' ? 'cm-rm-mermaid' : 'cm-rm-code-render'} cm-rm-preview`
    this.destroy(dom)
    this.mount(dom, view)
    return true
  }

  destroy(dom: HTMLElement) {
    rendererMounts.get(dom)?.()
    rendererMounts.delete(dom)
  }

  private mount(el: HTMLElement, view: EditorView) {
    let stop = () => {}
    const render = () => {
      stop()
      stop = mountContent(el, context => Promise.resolve(this.renderer.render({
        ...context,
        source: this.code,
        language: this.language,
        path: this.path,
        colorMode: document.documentElement.dataset.rmColorMode === 'dark' ? 'dark' : 'light',
      })).then((cleanup) => {
        requestAnimationFrame(() => view.requestMeasure()); return cleanup
      }), (error) => {
        showRenderError(el, error)
        this.renderer.fail(error)
        view.requestMeasure()
      })
    }
    render()
    window.addEventListener('rawmark-appearance', render)
    rendererMounts.set(el, () => {
      window.removeEventListener('rawmark-appearance', render); stop()
    })
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
    // Show original text until the name table loads or when the name is unknown.
    el.textContent = `:${this.name}:`
    void emojiFor(this.name).then((e) => {
      if (e) el.textContent = e
    })
    editOnMousedown(el, view, 1)
    return el
  }
}

export class FootnoteRefWidget extends WidgetType {
  readonly locale = locale.value
  constructor(
    readonly label: string,
    readonly definition: string | undefined,
  ) {
    super()
  }

  eq(other: FootnoteRefWidget) {
    return other.locale === this.locale && other.label === this.label && other.definition === this.definition
  }

  toDOM(view: EditorView) {
    const el = document.createElement('sup')
    el.className = 'cm-rm-footnote-ref'
    el.textContent = this.label
    el.title = this.definition ?? translate('workspace.footnote_definition_not_found_1c0993')
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
  readonly locale = locale.value
  constructor(readonly entries: TocEntry[]) {
    super()
  }

  eq(other: TocWidget) {
    return other.locale === this.locale && JSON.stringify(other.entries) === JSON.stringify(this.entries)
  }

  toDOM(view: EditorView) {
    const el = document.createElement('div')
    el.className = 'cm-rm-toc'
    if (!this.entries.length) {
      el.textContent = translate('workspace.table_of_contents_no_headings_c24b5d')
      el.classList.add('cm-rm-placeholder')
    }
    const minLevel = Math.min(...this.entries.map(e => e.level))
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
    // Clicking empty table-of-contents space expands [TOC] source.
    editOnMousedown(el, view, 0)
    return el
  }
}
