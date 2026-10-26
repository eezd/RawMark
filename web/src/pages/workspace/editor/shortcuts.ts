import type { Command, KeyBinding } from '@codemirror/view'
import { typoraKeys } from '@@/utils/typora-keys'
import { indentLess, indentMore, redo, selectAll, undo } from '@codemirror/commands'
import { selectCodeBlock } from './codeblocks'
import { insertLink, toggleBlock, toggleBold, toggleCode, toggleHeading, toggleItalic } from './format'
import { toggleSelectionMark, toggleUnderline } from './inline-styles'

export const editorCommands: { id: string, title: string, keys: string[], run: Command }[] = [
  { id: 'editor.bold', title: '粗体', keys: typoraKeys('editor.bold'), run: toggleBold },
  { id: 'editor.italic', title: '斜体', keys: typoraKeys('editor.italic'), run: toggleItalic },
  { id: 'editor.underline', title: '下划线', keys: typoraKeys('editor.underline'), run: toggleUnderline },
  { id: 'editor.strike', title: '删除线', keys: typoraKeys('editor.strike'), run: toggleSelectionMark('Strikethrough') },
  { id: 'editor.highlight', title: '高亮', keys: [], run: toggleSelectionMark('Highlight') },
  { id: 'editor.code', title: '行内代码', keys: typoraKeys('editor.code'), run: toggleCode },
  ...(['task', 'bullet', 'ordered', 'quote'] as const).map(kind => ({ id: `editor.${kind}`, title: { task: '任务列表', bullet: '无序列表', ordered: '有序列表', quote: '引用' }[kind], keys: typoraKeys(`editor.${kind}`), run: toggleBlock(kind) })),
  { id: 'editor.link', title: '插入链接', keys: typoraKeys('editor.link'), run: insertLink },
  { id: 'editor.undo', title: '撤销', keys: typoraKeys('editor.undo'), run: undo },
  { id: 'editor.redo', title: '重做', keys: typoraKeys('editor.redo'), run: redo },
  { id: 'editor.indent', title: '增加缩进', keys: typoraKeys('editor.indent'), run: indentMore },
  { id: 'editor.outdent', title: '减少缩进', keys: typoraKeys('editor.outdent'), run: indentLess },
  { id: 'editor.selectAll', title: '全选（代码块内优先选中代码块）', keys: typoraKeys('editor.selectAll'), run: view => selectCodeBlock(view) || selectAll(view) },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `editor.heading${i + 1}`, title: `设置 ${i + 1} 级标题`, keys: typoraKeys(`editor.heading${i + 1}`), run: toggleHeading(i + 1) })),
]

export const defaultEditorKeys: KeyBinding[] = editorCommands.flatMap(command => command.keys.map(key => ({ key: key.replaceAll('+', '-').replace(/-[A-Z]$/, letter => letter.toLowerCase()), run: command.run, preventDefault: true })))
