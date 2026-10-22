import { describe, expect, it } from 'vitest'
import { localDate, renderTemplate } from './template'

describe('Markdown 模板', () => {
  it('按本地日期替换变量，资源相对新笔记重定位并保留代码示例', () => {
    const now = new Date(2026, 9, 22, 8, 5)
    const source = '# {{title}}\n{{date}} {{time}}\n![图](assets/a.png) [文档][ref]\n\n[ref]: ../docs/guide.md#标题\n\n`![](assets/a.png)`\n```\n![](assets/a.png)\n```'
    expect(localDate(now)).toBe('2026-10-22')
    const result = renderTemplate(source, 'Templates/日记.md', 'Daily/2026-10-22.md', now)
    expect(result).toContain('# 2026-10-22\n2026-10-22 08:05')
    expect(result).toContain('![图](../Templates/assets/a.png)')
    expect(result).toContain('[ref]: ../docs/guide.md#%E6%A0%87%E9%A2%98')
    expect(result).toContain('`![](assets/a.png)`\n```\n![](assets/a.png)\n```')
  })
})
