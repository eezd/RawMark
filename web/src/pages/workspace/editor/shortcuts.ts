import type { Command, KeyBinding } from '@codemirror/view'
import { t as translate } from '@@/i18n/runtime'
import { typoraKeys } from '@@/utils/typora-keys'
import { indentLess, indentMore, redo, selectAll, undo } from '@codemirror/commands'
import { selectCodeBlock } from './codeblocks'
import { insertLink, toggleBlock, toggleBold, toggleCode, toggleHeading, toggleItalic } from './format'
import { toggleSelectionMark, toggleUnderline } from './inline-styles'

export const editorCommands: { id: string, title: string, keys: string[], run: Command }[] = [
  { id: 'editor.bold', get title() {
    return translate('workspace.bold_f6da93')
  }, keys: typoraKeys('editor.bold'), run: toggleBold },
  { id: 'editor.italic', get title() {
    return translate('workspace.italic_217901')
  }, keys: typoraKeys('editor.italic'), run: toggleItalic },
  { id: 'editor.underline', get title() {
    return translate('workspace.underline_d3b4a2')
  }, keys: typoraKeys('editor.underline'), run: toggleUnderline },
  { id: 'editor.strike', get title() {
    return translate('workspace.strikethrough_5b0508')
  }, keys: typoraKeys('editor.strike'), run: toggleSelectionMark('Strikethrough') },
  { id: 'editor.highlight', get title() {
    return translate('workspace.highlight_05f954')
  }, keys: [], run: toggleSelectionMark('Highlight') },
  { id: 'editor.code', get title() {
    return translate('workspace.inline_code_6711d9')
  }, keys: typoraKeys('editor.code'), run: toggleCode },
  ...(['task', 'bullet', 'ordered', 'quote'] as const).map(kind => ({ id: `editor.${kind}`, get title() {
    return { get task() {
      return translate('workspace.task_list_c5ced4')
    }, get bullet() {
      return translate('workspace.bulleted_list_9ee577')
    }, get ordered() {
      return translate('workspace.numbered_list_5d0bb2')
    }, get quote() {
      return translate('workspace.block_quote')
    } }[kind]
  }, keys: typoraKeys(`editor.${kind}`), run: toggleBlock(kind) })),
  { id: 'editor.link', get title() {
    return translate('workspace.insert_link_1ad3ca')
  }, keys: typoraKeys('editor.link'), run: insertLink },
  { id: 'editor.undo', get title() {
    return translate('workspace.undo_926a50')
  }, keys: typoraKeys('editor.undo'), run: undo },
  { id: 'editor.redo', get title() {
    return translate('workspace.redo_03717b')
  }, keys: typoraKeys('editor.redo'), run: redo },
  { id: 'editor.indent', get title() {
    return translate('workspace.increase_indent_cfd42c')
  }, keys: typoraKeys('editor.indent'), run: indentMore },
  { id: 'editor.outdent', get title() {
    return translate('workspace.decrease_indent_efd955')
  }, keys: typoraKeys('editor.outdent'), run: indentLess },
  { id: 'editor.selectAll', get title() {
    return translate('workspace.select_all_select_code_inside_8dfb27')
  }, keys: typoraKeys('editor.selectAll'), run: view => selectCodeBlock(view) || selectAll(view) },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `editor.heading${i + 1}`, get title() {
    return translate('workspace.heading_a4f510', { p0: i + 1 })
  }, keys: typoraKeys(`editor.heading${i + 1}`), run: toggleHeading(i + 1) })),
]

export const defaultEditorKeys: KeyBinding[] = editorCommands.flatMap(command => command.keys.map(key => ({ key: key.replaceAll('+', '-').replace(/-[A-Z]$/, letter => letter.toLowerCase()), run: command.run, preventDefault: true })))
