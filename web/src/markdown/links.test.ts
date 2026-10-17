import { expect, it } from 'vitest'
import { imageLinks, rewriteImageLinks } from './links'

it('只列出图片与引用定义的地址，跳过普通链接和代码', () => {
  const src = [
    '![a](a.assets/1.png) [链接](a.assets/2.png) ![b](<a.assets/有 空格.png> "标题")',
    '',
    '`![c](a.assets/3.png)`',
    '',
    '```',
    '![d](a.assets/4.png)',
    '```',
    '',
    '![e][ref]',
    '',
    '[ref]: a.assets/5.png',
  ].join('\n')
  expect(imageLinks(src).map((l) => l.url)).toEqual(['a.assets/1.png', 'a.assets/有 空格.png', 'a.assets/5.png'])
  expect(rewriteImageLinks(src, (u) => (u.endsWith('5.png') ? undefined : u.replace('a.assets', 'b.assets')))).toBe(
    src.replace('a.assets/1.png', 'b.assets/1.png').replace('a.assets/有 空格', 'b.assets/有 空格'),
  )
})
