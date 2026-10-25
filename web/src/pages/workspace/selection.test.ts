import { expect, it } from 'vitest'
import { minimalPaths, rangePaths } from './selection'

it('消除重叠主体，不受相似目录排序干扰', () => {
  expect(minimalPaths(['a/b.md', 'a-b.md', 'a', 'a', 'z.md'])).toEqual(['a', 'a-b.md', 'z.md'])
})
it('shift 范围只使用可见项，允许向上选择和丢失锚点', () => {
  expect(rangePaths(['a', 'a/x.md', 'b'], 'b', 'a')).toEqual(['a', 'a/x.md', 'b'])
  expect(rangePaths(['a', 'b'], 'removed', 'b')).toEqual(['b'])
})
