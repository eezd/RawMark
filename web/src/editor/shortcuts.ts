import { indentLess, indentMore, redo, selectAll, undo } from '@codemirror/commands'
import type { Command, KeyBinding } from '@codemirror/view'
import { selectCodeBlock } from './codeblocks'
import { insertLink, toggleBold, toggleHeading, toggleItalic } from './format'

export const editorCommands: { id: string; title: string; keys: string[]; run: Command }[] = [
  { id: 'editor.bold', title: '粗体', keys: ['Mod+B'], run: toggleBold },
  { id: 'editor.italic', title: '斜体', keys: ['Mod+I'], run: toggleItalic },
  { id: 'editor.link', title: '插入链接', keys: ['Mod+K'], run: insertLink },
  { id: 'editor.undo', title: '撤销', keys: ['Mod+Z'], run: undo },
  { id: 'editor.redo', title: '重做', keys: ['Mod+Shift+Z', 'Mod+Y'], run: redo },
  { id: 'editor.indent', title: '增加缩进', keys: ['Tab'], run: indentMore },
  { id: 'editor.outdent', title: '减少缩进', keys: ['Shift+Tab'], run: indentLess },
  { id: 'editor.selectAll', title: '全选（代码块内优先选中代码块）', keys: ['Mod+A'], run: (view) => selectCodeBlock(view) || selectAll(view) },
  ...Array.from({ length: 6 }, (_, i) => ({ id: `editor.heading${i + 1}`, title: `设置 ${i + 1} 级标题`, keys: [`Ctrl+Alt+${i + 1}`], run: toggleHeading(i + 1) })),
]

export const defaultEditorKeys: KeyBinding[] = editorCommands.flatMap((command) => command.keys.map((key) => ({ key: key.replaceAll('+', '-').replace(/-[A-Z]$/, (letter) => letter.toLowerCase()), run: command.run, preventDefault: true })))
