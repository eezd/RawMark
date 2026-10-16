import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands'
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { codeBlockHighlight } from './codeblocks'
import { livePreview, resolveImageUrl } from './livepreview'
import { tableEditing } from './table'
import { markdownTheme } from './theme'

export { pasteImages } from './paste'

export interface EditorStateOptions {
  doc: string
  resolveImage?: (src: string) => string
  // 文档变化回调，仅对挂载在视图上的状态触发；未激活标签页的状态由调用方直接更新
  onChange?: (update: ViewUpdate) => void
  extensions?: Extension[]
}

// 每个打开的笔记各自持有一个 EditorState（含撤销历史），切换标签页时整体替换
export function createEditorState(opts: EditorStateOptions): EditorState {
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
    // CodeMirror 只在 Linux/Mac 上把 Ctrl/Cmd+Shift+Z 绑定为重做，Windows 上会退化成撤销；
    // 与 Typora、VS Code 保持一致，所有平台都支持
    keymap.of([indentWithTab, { key: 'Mod-Shift-z', run: redo, preventDefault: true }, ...defaultKeymap, ...historyKeymap]),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'sentences' }),
  ]
  if (opts.resolveImage) extensions.push(resolveImageUrl.of(opts.resolveImage))
  if (opts.onChange) {
    const onChange = opts.onChange
    extensions.push(EditorView.updateListener.of((u) => u.docChanged && onChange(u)))
  }
  if (opts.extensions) extensions.push(...opts.extensions)
  return EditorState.create({ doc: opts.doc, extensions })
}

export function createEditorView(parent: HTMLElement, state: EditorState): EditorView {
  return new EditorView({ parent, state })
}
