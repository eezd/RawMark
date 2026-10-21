import { defaultKeymap, history, selectAll } from '@codemirror/commands'
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { Language } from '@codemirror/language'
import { Compartment, EditorState, Prec, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, keymap, type KeyBinding, type ViewUpdate } from '@codemirror/view'
import type { MarkdownParser } from '@lezer/markdown'
import { typoraExtensions } from '../markdown/extensions'
import { renderedBlocks } from './blocks'
import { codeBlockHighlight } from './codeblocks'
import { editorFocus } from './focus'
import { defaultEditorKeys } from './shortcuts'
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
export const previewCompartment = new Compartment()
export function previewExtensions(sourceMode: boolean): Extension {
  return sourceMode ? EditorView.contentAttributes.of({ class: 'cm-rm-source' }) : [livePreview, tableEditing, renderedBlocks]
}
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
  sourceMode?: boolean
  shortcuts?: KeyBinding[]
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
    Prec.high(keymap.of(opts.shortcuts ?? defaultEditorKeys)),
    markdownTheme,
    codeBlockHighlight,
    editorFocus,
    previewCompartment.of(previewExtensions(opts.sourceMode ?? false)),
    // 可配置操作不再通过 CM 的默认绑定重复注册。
    keymap.of(defaultKeymap.filter((binding) => binding.run !== selectAll)),
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
