import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import { codeBlockHighlight } from './codeblocks'
import { livePreview, resolveImageUrl } from './livepreview'
import { tableEditing } from './table'
import { markdownTheme } from './theme'

export interface EditorOptions {
  parent: HTMLElement
  doc: string
  resolveImage?: (src: string) => string
  onChange?: (state: EditorState) => void
  extensions?: Extension[]
}

export function createEditor(opts: EditorOptions): EditorView {
  const extensions: Extension[] = [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    // 不用 lang-markdown 的 markdown()：它会静态引入 lang-html/css/javascript 用于嵌套 HTML 高亮，
    // 首屏包 gzip 从约 108 KB 增至约 180 KB，而 Live Preview 不需要 HTML 高亮
    markdownLanguage,
    Prec.high(keymap.of(markdownKeymap)),
    markdownTheme,
    livePreview,
    codeBlockHighlight,
    tableEditing,
    keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'sentences' }),
  ]
  if (opts.resolveImage) extensions.push(resolveImageUrl.of(opts.resolveImage))
  if (opts.onChange) {
    const onChange = opts.onChange
    extensions.push(EditorView.updateListener.of((u) => u.docChanged && onChange(u.state)))
  }
  if (opts.extensions) extensions.push(...opts.extensions)
  return new EditorView({ parent: opts.parent, state: EditorState.create({ doc: opts.doc, extensions }) })
}
