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
      } else {
        walk(child)
      }
    }
  }
  walk(root as unknown as Node)
  return root.innerHTML
}

const examples = specTests.map(t => ({
  ...t,
  markdown: t.markdown.replace(/→/g, '\t'),
  html: t.html.replace(/→/g, '\t'),
}))

// @lezer/markdown 1.8.0 解析结果本身偏离规范的用例（已逐个核对语法树，非渲染器问题）：
// 制表符 ATX 标题、空列表项后的段落、<textarea> HTML 块、方括号嵌套与链接优先级、非法 HTML 标签/注释。
// 用 it.fails 标记：上游修复后这些用例会转为通过并报错，提醒移出此列表。
const PARSER_DEVIATIONS = new Set([10, 171, 280, 493, 512, 523, 528, 569, 571, 621, 625, 626])

describe('安全模式', () => {
  it('转义原始 HTML', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>\n\na <b>b</b>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;\n<p>a &lt;b&gt;b&lt;/b&gt;</p>\n',
    )
  })
  it('过滤危险链接协议', () => {
    expect(renderMarkdown('[a](javascript:alert(1)) <javascript:x> ![i](data:image/png;base64,AA)')).toBe(
      '<p><a href="#">a</a> <a href="#">javascript:x</a> <img src="data:image/png;base64,AA" alt="i" /></p>\n',
    )
  })
  it('按浏览器解码后的协议过滤实体及控制字符', () => {
    for (const href of ['javascript&#58;void(0)', 'java&#x73;cript:void(0)', 'javascript&colon;void(0)', 'java&Tab;script&colon;void(0)', '&#13;javascript:void(0)']) {
      const root = document.createElement('div')
      root.innerHTML = renderMarkdown(`[x](${href})`)
      expect(root.querySelector('a')?.getAttribute('href')).toBe('#')
    }
    expect(renderMarkdown('[x](https://example.com/?a=1&amp;b=2)')).toContain('https://example.com/?a=1&amp;b=2')
  })
})

describe('typora 扩展', () => {
  it('任务列表保留嵌套列表和后续段落，正确处理松散与紧凑列表', () => {
    expect(normalize(renderMarkdown('- [ ] 父任务\n  - 子任务\n\n  后续说明\n'))).toBe(normalize(
      '<ul><li><p><input type="checkbox" disabled="" /> 父任务</p><ul><li>子任务</li></ul><p>后续说明</p></li></ul>',
    ))
    expect(normalize(renderMarkdown('- [x] 已完成\n  - [ ] 子任务\n- [ ] 下一项\n'))).toBe(normalize(
      '<ul><li><input type="checkbox" disabled="" checked="" /> 已完成\n<ul><li><input type="checkbox" disabled="" /> 子任务</li></ul></li><li><input type="checkbox" disabled="" /> 下一项</li></ul>',
    ))
  })
  it('高亮、上下标、脚注引用', () => {
    expect(renderMarkdown('==a== x^2^ H~2~O[^1]')).toBe('<p><mark>a</mark> x<sup>2</sup> H<sub>2</sub>O<sup class="footnote-ref"><a href="#fn-1">1</a></sup></p>\n')
  })
  it('公式与 emoji 输出待填充的占位元素，内容被转义', () => {
    expect(renderMarkdown('$a<b$ :smile:')).toBe('<p><span data-math="a&lt;b">a&lt;b</span> <span data-emoji="smile">:smile:</span></p>\n')
    expect(renderMarkdown('$$\n"><img src=x onerror=alert(1)>\n$$')).toBe(
      '<div data-math="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</div>\n',
    )
  })
  it('脚注定义、front matter 与 [TOC]', () => {
    expect(renderMarkdown('---\ntitle: x\n---\n[TOC]\n\n[^1]: 说明 **重点**')).toBe('<nav class="toc"></nav>\n<div class="footnote" id="fn-1"><sup>1</sup> 说明 <strong>重点</strong></div>\n')
  })
})

describe('commonMark spec', () => {
  for (const e of examples) {
    const test = PARSER_DEVIATIONS.has(e.number) ? it.fails : it
    test(`#${e.number} ${e.section}`, () => {
      expect(normalize(renderMarkdown(e.markdown, { parser: commonmarkParser, unsafe: true }))).toBe(normalize(e.html))
    })
  }
})
