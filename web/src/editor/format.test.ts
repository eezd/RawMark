import { EditorSelection, EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { cycleHeading, insertLink, toggleBlock, toggleBold, toggleCode, toggleItalic, type FormatCommand } from './format'

// 用 | 标记光标、[ ] 标记选区，执行命令后以同样的形式返回结果
function run(cmd: FormatCommand, doc: string): string {
  const ranges: { anchor: number; head: number }[] = []
  let text = ''
  let start = -1
  for (const ch of doc) {
    if (ch === '|') ranges.push({ anchor: text.length, head: text.length })
    else if (ch === '[' && start < 0 && doc.includes(']')) start = text.length
    else if (ch === ']' && start >= 0) {
      ranges.push({ anchor: start, head: text.length })
      start = -2
    } else text += ch
  }
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head))),
    extensions: EditorState.allowMultipleSelections.of(true),
  })
  cmd({ state, dispatch: (spec) => (state = state.update(spec).state) })
  let out = state.doc.toString()
  for (const r of [...state.selection.ranges].reverse()) {
    out = r.empty ? out.slice(0, r.from) + '|' + out.slice(r.from) : out.slice(0, r.from) + '[' + out.slice(r.from, r.to) + ']' + out.slice(r.to)
  }
  return out
}

describe('行内标记', () => {
  it('加上与去掉', () => {
    expect(run(toggleBold, 'a [bc] d')).toBe('a **[bc]** d')
    expect(run(toggleBold, 'a **[bc]** d')).toBe('a [bc] d')
    expect(run(toggleBold, 'a [**bc**] d')).toBe('a [bc] d')
    expect(run(toggleCode, 'x|')).toBe('x`|`')
  })
  it('粗体与斜体叠加', () => {
    expect(run(toggleItalic, '**[x]**')).toBe('***[x]***')
    expect(run(toggleItalic, '***[x]***')).toBe('**[x]**')
    expect(run(toggleBold, '***[x]***')).toBe('*[x]*')
    expect(run(toggleBold, '*[x]*')).toBe('***[x]***')
  })
})

describe('行首标记', () => {
  it('列表、任务、引用：同类再按去掉，异类替换', () => {
    expect(run(toggleBlock('bullet'), 'a|')).toBe('- a|')
    expect(run(toggleBlock('bullet'), '- a|')).toBe('a|')
    expect(run(toggleBlock('task'), '- a|')).toBe('- [ ] a|')
    expect(run(toggleBlock('quote'), '## 标题|')).toBe('> 标题|')
    expect(run(toggleBlock('bullet'), '|')).toBe('- |')
  })
  it('多行：有序列表按行编号，保留缩进', () => {
    expect(run(toggleBlock('ordered'), '[a\n  b\nc]')).toBe('[1. a\n  2. b\n3. c]')
    expect(run(toggleBlock('ordered'), '[1. a\n2. b]')).toBe('[a\nb]')
    // 部分行已是该类型时统一加上
    expect(run(toggleBlock('bullet'), '[- a\nb]')).toBe('[- a\n- b]')
  })
  it('标题循环', () => {
    expect(run(cycleHeading, '标题|')).toBe('# 标题|')
    expect(run(cycleHeading, '# 标题|')).toBe('## 标题|')
    expect(run(cycleHeading, '### 标题|')).toBe('标题|')
    expect(run(cycleHeading, '- 项|')).toBe('# 项|')
  })
})

it('链接', () => {
  expect(run(insertLink, '看 [文档] 吧')).toBe('看 [文档](|) 吧')
  expect(run(insertLink, '看|')).toBe('看[|]()')
})
