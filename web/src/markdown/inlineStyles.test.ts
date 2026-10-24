import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './html'
import { INLINE_FONTS, parseInlineStyles } from './inlineStyles'

describe('行内外观安全渲染', () => {
  it('下划线和白名单样式支持嵌套格式和表格', () => {
    expect(renderMarkdown('<u>**bold**</u> <span style="color: #AABBCC; font-size: 20px">[link](https://example.com)</span>')).toBe('<p><u><strong>bold</strong></u> <span style="color: #aabbcc; font-size: 20px"><a href="https://example.com">link</a></span></p>\n')
    expect(renderMarkdown('| value |\n| --- |\n| <u>text</u> |')).toContain('<td><u>text</u></td>')
    expect(parseInlineStyles('font-family: ' + INLINE_FONTS.serif.css)).not.toBeNull()
  })
  it('拒绝事件、额外属性、外部资源及任意 CSS', () => {
    for (const tag of ['<u onclick="alert(1)">', '<span style="color: #aabbcc" onclick="alert(1)">', '<span style="background: url(https://example.com)">', '<span style="position: fixed; color: #aabbcc">', '<span style="font-size: 999px">']) {
      const html = renderMarkdown('text ' + tag + 'unsafe</span>')
      expect(html).toContain('&lt;')
      expect(html).not.toContain(tag)
    }
    expect(renderMarkdown('<script>alert(1)</script>')).not.toContain('<script>')
    expect(renderMarkdown('<u>[x](javascript:alert(1))</u>')).toContain('href="#"')
  })
})
