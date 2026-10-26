import { parser as base, GFM } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'
import { typoraExtensions } from './extensions'

const parser = base.configure([GFM, ...typoraExtensions])

/** List original text covered by nodes of the specified type. */
function nodes(src: string, name: string): string[] {
  const out: string[] = []
  parser.parse(src).iterate({
    enter(n) {
      if (n.name === name) out.push(src.slice(n.from, n.to))
    },
  })
  return out
}

describe('typora 扩展语法', () => {
  it('==高亮==', () => {
    expect(nodes('a ==b c== d', 'Highlight')).toEqual(['==b c=='])
    expect(nodes('a == b ==', 'Highlight')).toEqual([])
    expect(nodes('x === y', 'Highlight')).toEqual([])
  })

  it('行内公式：金额与转义不误判', () => {
    expect(nodes('设 $x^2 + y$ 为', 'InlineMath')).toEqual(['$x^2 + y$'])
    expect(nodes('价格 $5 和 $10', 'InlineMath')).toEqual([])
    expect(nodes('$ x$ 与 $x $', 'InlineMath')).toEqual([])
    expect(nodes('\\$x$ 不是公式', 'InlineMath')).toEqual([])
    expect(nodes('$a\\$b$', 'InlineMath')).toEqual(['$a\\$b$'])
    expect(nodes('`$x$`', 'InlineMath')).toEqual([])
  })

  it('公式块：可打断段落，只在顶层识别，未闭合延续到文末', () => {
    expect(nodes('段落\n$$\na^2\n$$\n后文', 'BlockMath')).toEqual(['$$\na^2\n$$'])
    expect(nodes('> $$\n> x\n> $$\n\n外面', 'BlockMath')).toEqual([])
    expect(nodes('$$\nx\n', 'BlockMath')).toEqual(['$$\nx\n'])
    expect(nodes('$$x$$', 'BlockMath')).toEqual([])
  })

  it('脚注引用与定义', () => {
    expect(nodes('正文[^1]与[^note]。', 'FootnoteReference')).toEqual(['[^1]', '[^note]'])
    expect(nodes('[^ 1] 不是脚注', 'FootnoteReference')).toEqual([])
    expect(nodes('[^1]: 第一行\n继续\n\n下一段', 'FootnoteDefinition')).toEqual(['[^1]: 第一行\n继续'])
    expect(nodes('[^1]: 有 **粗体**', 'StrongEmphasis')).toEqual(['**粗体**'])
    expect(nodes('[^1]: x', 'LinkReference')).toEqual([])
  })

  it('[TOC] 独占一行', () => {
    expect(nodes('[TOC]\n\n# 标题', 'TableOfContents')).toEqual(['[TOC]'])
    expect(nodes('[toc]  ', 'TableOfContents')).toEqual(['[toc]  '])
    expect(nodes('见 [TOC] 处', 'TableOfContents')).toEqual([])
  })

  it('yAML front matter 只在文档首行', () => {
    expect(nodes('---\ntitle: a\n---\n# 正文', 'FrontMatter')).toEqual(['---\ntitle: a\n---'])
    expect(nodes('---\ntitle: a\n...\n正文', 'FrontMatter')).toEqual(['---\ntitle: a\n...'])
    expect(nodes('正文\n\n---\na: b\n---', 'FrontMatter')).toEqual([])
    expect(nodes('正文\n\n---\n', 'HorizontalRule')).toEqual(['---'])
    // After front matter closes, --- is parsed as a thematic break again.
    expect(nodes('---\na: 1\n---\n\n---\n', 'HorizontalRule')).toEqual(['---'])
  })
})
