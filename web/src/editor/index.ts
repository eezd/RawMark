import { defaultKeymap, history, historyKeymap, indentWithTab, redo } from '@codemirror/commands'
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { Language } from '@codemirror/language'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import type { MarkdownParser } from '@lezer/markdown'
import { typoraExtensions } from '../markdown/extensions'
import { renderedBlocks } from './blocks'
import { codeBlockHighlight } from './codeblocks'
import { editorFocus } from './focus'
import { insertLink, toggleBold, toggleItalic } from './format'
import { livePreview, resolveImageUrl } from './livepreview'
import { tableEditing } from './table'
import { markdownTheme } from './theme'
import { editorExtensions, markdownSyntax, reportEditorFailure } from '../plugins/registry'

export { insertImageFiles, pasteImages } from './paste'

// 在 lang-markdown 的语法集（CommonMark + GFM + 上下标 + emoji）上加 Typora 扩展。
// 沿用其语言数据，markdownKeymap 中的命令据此识别 Markdown（isActiveAt 按语言数据判断）
export const pluginCompartment = new Compartment()
export const languageCompartment = new Compartment()
export const preferencesCompartment = new Compartment()
export function pluginLanguage() { return new Language(
  markdownLanguage.data,
  (markdownLanguage.parser as MarkdownParser).configure([typoraExtensions, ...[...markdownSyntax.values()].map((entry) => entry.value)]),
  [],
  'markdown',
) }
export function pluginEditorExtensions(): Extension[] { return [...editorExtensions.values()].map((entry) => entry.value) }

export interface EditorStateOptions {
  doc: string
  spellcheck?: boolean
  tabSize?: number
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
    languageCompartment.of(pluginLanguage()),
    pluginCompartment.of(pluginEditorExtensions()),
    EditorView.exceptionSink.of(reportEditorFailure),
    Prec.high(keymap.of(markdownKeymap)),
    // 与 Typora 一致的格式快捷键
    Prec.high(
      keymap.of([
        { key: 'Mod-b', run: toggleBold, preventDefault: true },
        { key: 'Mod-i', run: toggleItalic, preventDefault: true },
        { key: 'Mod-k', run: insertLink, preventDefault: true },
      ]),
    ),
    markdownTheme,
    livePreview,
    codeBlockHighlight,
    editorFocus,
    tableEditing,
    renderedBlocks,
    // CodeMirror 只在 Linux/Mac 上把 Ctrl/Cmd+Shift+Z 绑定为重做，Windows 上会退化成撤销；
    // 与 Typora、VS Code 保持一致，所有平台都支持
    keymap.of([indentWithTab, { key: 'Mod-Shift-z', run: redo, preventDefault: true }, ...defaultKeymap, ...historyKeymap]),
    preferencesCompartment.of([
      EditorState.tabSize.of(opts.tabSize ?? 4),
      EditorView.contentAttributes.of({ spellcheck: String(opts.spellcheck ?? false) }),
    ]),
    EditorView.contentAttributes.of({ autocapitalize: 'sentences' }),
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
  const view = new EditorView({ parent, state })
  const dispatch = view.dispatch.bind(view)
  view.dispatch = (...args: unknown[]) => {
    try { Reflect.apply(dispatch, view, args) } catch (error) { reportEditorFailure(error) }
  }
  return view
}
