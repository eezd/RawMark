// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { applyFontCatalog, parseFontCatalog } from './fonts'

describe('导入字体资源边界', () => {
  it('拒绝可插入CSS的标识和不支持的格式', () => {
    for (const value of [null, {}, [{}], [{ id: 'custom-\');}body{color:red}', name: 'bad', format: 'woff2' }], [{ id: `custom-${'a'.repeat(64)}`, name: 'bad', format: 'exe' }]]) {
      expect(() => parseFontCatalog(value)).toThrow('字体列表格式无效')
    }
  })
  it('字体名称只供界面显示，不进入CSS；设置同步不重复替换相同字体声明', () => {
    const fonts = parseFontCatalog([{ id: `custom-${'a'.repeat(64)}`, name: 'bad\');}body{color:red}', format: 'woff2' }])
    applyFontCatalog(fonts)
    const style = document.querySelector('#rm-custom-fonts')!
    expect(style.textContent).not.toContain('body{color:red}')
    const text = style.firstChild
    applyFontCatalog(fonts)
    expect(style.firstChild).toBe(text)
    applyFontCatalog([])
  })
})

vi.mock('@@/utils/resource-tickets', () => ({
  prepareResources: async () => {},
  imageResourceRoot: () => '/api/v1/resources/test-images/images/',
  fontResourceRoot: () => '/api/v1/resources/test-fonts/fonts/',
  pluginResourceURL: async (id: string, revision: string) => `/api/v1/resources/test-plugin/plugin/plugins/${id}/assets/${revision}/main.js`,
}))
