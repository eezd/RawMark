import { expect, it } from 'vitest'
import { hiddenAssetPath, imageInFolder } from './paths'

it('图片管理仅包含当前目录和直属附件子树', () => {
  expect(imageInFolder('项目/a.png', '项目')).toBe(true)
  expect(imageInFolder('项目/笔记.assets/嵌套/a.png', '项目')).toBe(true)
  expect(imageInFolder('项目/assets/a.png', '项目')).toBe(true)
  expect(imageInFolder('项目/子目录/assets/a.png', '项目')).toBe(false)
  expect(imageInFolder('项目二/a.png', '项目')).toBe(false)
  expect(imageInFolder('项目/a.md', '项目')).toBe(false)
  expect(imageInFolder('assets/a.png', '')).toBe(true)
})

it('导航隐藏附件目录的完整子树而不误伤相似名称', () => {
  expect(hiddenAssetPath('项目/assets/a.png')).toBe(true)
  expect(hiddenAssetPath('项目/a.assets')).toBe(true)
  expect(hiddenAssetPath('项目/myassets/a.png')).toBe(false)
})
