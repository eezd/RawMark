import type { Extension } from '@codemirror/state'
import type { KeyBinding, ViewUpdate } from '@codemirror/view'
import type { MarkdownParser } from '@lezer/markdown'
import { locale } from '@@/i18n/runtime'
import { typoraExtensions } from '@@/markdown/extensions'
import { editorExtensions, markdownSyntax, reportEditorFailure } from '@@/plugins/registry'
import { defaultKeymap, history, indentLess, indentMore, selectAll, selectParentSyntax, toggleComment } from '@codemirror/commands'
import { markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown'
import { Language } from '@codemirror/language'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { drawSelection, EditorView, keymap } from '@codemirror/view'
import { renderedBlocks } from './blocks'
import { codeBlockHighlight } from './codeblocks'
import { editorFocus } from './focus'
import { livePreview, openLink, resolveImageUrl } from './livepreview'
import { editorLocale, localeCompartment } from './locale'
import { defaultEditorKeys } from './shortcuts'
import { tableEditing } from './table'
import { markdownTheme } from './theme'

export { insertImageFiles, pasteImages } from './paste'

// Add Typora extensions to lang-markdown's syntax set (CommonMark, GFM, superscript/subscript, and emoji).
// Reuse its language data so markdownKeymap commands recognize Markdown through isActiveAt.
export const pluginCompartment = new Compartment()
export const languageCompartment = new Compartment()
export const preferencesCompartment = new Compartment()
export const previewCompartment = new Compartment()
export function previewExtensions(sourceMode: boolean): Extension {
  return sourceMode ? EditorView.contentAttributes.of({ class: 'cm-rm-source' }) : [livePreview, tableEditing, renderedBlocks]
}
export function pluginLanguage() {
  return new Language(
    markdownLanguage.data,
    (markdownLanguage.parser as MarkdownParser).configure([typoraExtensions, ...[...markdownSyntax.values()].map(entry => entry.value)]),
    [],
    'markdown',
  )
}
export function pluginEditorExtensions(): Extension[] {
  return [...editorExtensions.values()].map(entry => entry.value)
}

export interface EditorStateOptions {
  doc: string
  spellcheck?: boolean
  tabSize?: number
  sourceMode?: boolean
  shortcuts?: KeyBinding[]
  resolveImage?: (src: string) => string
  openLink?: (href: string) => void
  // Notify document changes only for the state mounted in the view; callers update inactive-tab states directly.
  onChange?: (update: ViewUpdate) => void
  extensions?: Extension[]
}

// Each open note owns an EditorState with undo history; replace the entire state on tab switches.
export function createEditorState(opts: EditorStateOptions): EditorState {
  const extensions: Extension[] = [
    history(),
    localeCompartment.of(editorLocale.of(locale.value)),
    drawSelection(),
    EditorView.lineWrapping,
    // Avoid lang-markdown's markdown(): its static lang-html/css/javascript imports enable nested HTML highlighting,
    // increasing the initial gzip bundle from roughly 108 KB to 180 KB, while Live Preview does not need HTML highlighting.
    languageCompartment.of(pluginLanguage()),
    pluginCompartment.of(pluginEditorExtensions()),
    EditorView.exceptionSink.of(reportEditorFailure),
    Prec.high(keymap.of(markdownKeymap)),
    Prec.high(keymap.of(opts.shortcuts ?? defaultEditorKeys)),
    markdownTheme,
    codeBlockHighlight,
    editorFocus,
    previewCompartment.of(previewExtensions(opts.sourceMode ?? false)),
    // Do not register configurable actions again through CodeMirror's default bindings.
    keymap.of(defaultKeymap.filter(binding => binding.run !== selectAll && binding.run !== indentLess && binding.run !== indentMore && binding.run !== selectParentSyntax && binding.run !== toggleComment)),
    preferencesCompartment.of([
      EditorState.tabSize.of(opts.tabSize ?? 4),
      EditorView.contentAttributes.of({ spellcheck: String(opts.spellcheck ?? false) }),
    ]),
    EditorView.contentAttributes.of({ autocapitalize: 'sentences' }),
  ]
  if (opts.openLink) extensions.push(openLink.of(opts.openLink))
  if (opts.resolveImage) extensions.push(resolveImageUrl.of(opts.resolveImage))
  if (opts.onChange) {
    const onChange = opts.onChange
    extensions.push(EditorView.updateListener.of(u => u.docChanged && onChange(u)))
  }
  if (opts.extensions) extensions.push(...opts.extensions)
  return EditorState.create({ doc: opts.doc, extensions })
}

export function createEditorView(parent: HTMLElement, state: EditorState): EditorView {
  const view = new EditorView({ parent, state })
  const dispatch = view.dispatch.bind(view)
  view.dispatch = (...args: unknown[]) => {
    try {
      Reflect.apply(dispatch, view, args)
    } catch (error) {
      reportEditorFailure(error)
    }
  }
  return view
}
