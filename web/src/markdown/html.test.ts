import { tests as specTests } from 'commonmark-spec'
import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { commonmarkParser, renderMarkdown } from './html'

const window = new Window()
const document = window.document

// 规范化 HTML：解析为 DOM 后重新序列化，消除实体写法、标签间空白和 URL 编码差异
function normalize(html: string): string {
  const root = document.createElement('div')
  root.innerHTML = html
  for (const el of root.querySelectorAll('[href],[src]')) {
    for (const attr of ['href', 'src']) {
      const v = el.getAttribute(attr)
      if (v === null) continue
      try {
        el.setAttribute(attr, decodeURI(v))
      } catch {
        // 非法的百分号序列保持原样比较
      }
    }
  }
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 && !(child.parentNode as Element).closest?.('pre') && !child.textContent!.trim()) {
        child.parentNode!.removeChild(child)
      } else walk(child)
    }
  }
  walk(root as unknown as Node)
  return root.innerHTML
}

const examples = specTests.map((t) => ({
  ...t,
  markdown: t.markdown.replace(/→/g, '\t'),
  html: t.html.replace(/→/g, '\t'),
}))

// @lezer/markdown 1.8.0 解析结果本身偏离规范的用例（已逐个核对语法树，非渲染器问题）：
// 制表符 ATX 标题、空列表项后的段落、<textarea> HTML 块、方括号嵌套与链接优先级、非法 HTML 标签/注释。
// 用 it.fails 标记：上游修复后这些用例会转为通过并报错，提醒移出此列表。
const PARSER_DEVIATIONS = new Set([10, 171, 280, 493, 512, 523, 528, 569, 571, 621, 625, 626])

describe('CommonMark spec', () => {
  for (const e of examples) {
    const test = PARSER_DEVIATIONS.has(e.number) ? it.fails : it
    test(`#${e.number} ${e.section}`, () => {
      expect(normalize(renderMarkdown(e.markdown, commonmarkParser))).toBe(normalize(e.html))
    })
  }
})
