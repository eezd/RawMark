// @vitest-environment happy-dom
import { createApp, nextTick, type App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'
import { allCommands, commandKeys, formatKeys, registerCommand } from './commands'
import SettingsDialog from './SettingsDialog.vue'
import ShortcutSettings from './ShortcutSettings.vue'
import { DEFAULTS, loadSettings, settings, settingsSave, SettingsAppearanceError, updateSettings } from './settings'
import { searchSettings } from './settingsCatalog'
import { ws } from './workspace'
import { applyFontCatalog, customFonts } from './fonts'

let app: App | undefined
let host: HTMLElement | undefined
const cleanup: (() => void)[] = []
beforeEach(() => {
  applyFontCatalog([])
  Object.assign(settings, DEFAULTS, { colorMode: 'system', theme: 'default', cssSnippets: [], shortcuts: {} })
  Object.assign(settingsSave, { pending: 0, result: 'idle', error: '' })
  vi.spyOn(api, 'patchSettings').mockResolvedValue({})
  vi.spyOn(api, 'settings').mockResolvedValue({})
  vi.spyOn(api, 'fonts').mockResolvedValue([])
  vi.spyOn(api, 'maintenanceStatus').mockResolvedValue({ busy: false, operation: '', error: '', finishedAt: 0 })
  vi.spyOn(api, 'themes').mockResolvedValue([{ id: 'default', name: '默认', version: '1' }])
})
afterEach(() => {
  app?.unmount()
  app = undefined
  host?.remove()
  cleanup.splice(0).forEach(fn => fn())
  ws.settings = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function mount(component: typeof SettingsDialog | typeof ShortcutSettings) {
  host = document.createElement('div')
  document.body.append(host)
  app = createApp(component)
  app.mount(host)
}
async function search(selector: string, query: string) {
  const input = host!.querySelector<HTMLInputElement>(selector)!
  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('设置查找与重置', () => {
  it('分类按约定排序，令牌归入账户与安全', async () => {
    ws.settings = 'account'
    vi.spyOn(api, 'tokens').mockResolvedValue([])
    mount(SettingsDialog)
    expect([...host!.querySelectorAll('.rm-settings-tab')].map(el => el.textContent)).toEqual(['外观','编辑器','快捷键','插件','存储空间','回收站','账户与安全','关于'])
    await vi.waitFor(() => expect(host!.querySelector('#rm-setting-tokens')).not.toBeNull())
    expect(searchSettings('API 令牌')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'tokens', section: 'account' })]))
  })

  it('编辑器字号在输入时立即生效，无需回车或失焦', async () => {
    ws.settings = 'editor'
    mount(SettingsDialog)
    const input = host!.querySelector<HTMLInputElement>('#rm-font-size')!
    input.value = '24'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(settings.fontSize).toBe(24)
    expect(document.documentElement.style.getPropertyValue('--rm-font-size')).toBe('24px')
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ fontSize: 24 }))
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(settings.fontSize).toBe(24)
    input.dispatchEvent(new Event('blur'))
    expect(input.value).toBe('24')
  })

  it('移除日记和模板设置、搜索与命令入口', async () => {
    expect(searchSettings('日记')).toEqual([])
    expect(searchSettings('日历')).toEqual([])
    expect(DEFAULTS).not.toHaveProperty('dailyFolder')
    expect(searchSettings('模板')).toEqual([])
    expect(DEFAULTS).not.toHaveProperty('templatesFolder')
    ws.settings = 'appearance'
    mount(SettingsDialog)
    expect(host!.textContent).not.toContain('日记')
    expect(host!.querySelector('#rm-templates-folder')).toBeNull()
    expect(host!.textContent).not.toContain('模板')
  })

  it('界面与编辑器共用字体管理，删除预设同步恢复使用位置，Maple不可删除', async () => {
    settings.uiFont = settings.textFont = settings.codeFont = 'serif'
    ws.settings = 'appearance'
    mount(SettingsDialog)
    host!.querySelector<HTMLButtonElement>('#rm-ui-font')!.click()
    await nextTick()
    expect(host!.querySelector('button[aria-label^="删除字体 Maple"]')).toBeNull()
    host!.querySelector<HTMLButtonElement>('button[aria-label="删除字体 Noto Serif SC · 思源宋体"]')!.click()
    await vi.waitFor(() => expect(settings.hiddenFonts).toContain('serif'))
    expect(settings.uiFont).toBe('maple')
    expect(settings.textFont).toBe('maple')
    expect(settings.codeFont).toBe('maple')
    const editor = [...host!.querySelectorAll<HTMLButtonElement>('.rm-settings-tab')].find(button => button.textContent === '编辑器')!
    editor.click()
    await nextTick()
    host!.querySelector<HTMLButtonElement>('#rm-text-font')!.click()
    await nextTick()
    expect(host!.querySelector('.rm-font-options')!.textContent).not.toContain('Noto Serif SC')
    expect(host!.querySelector('.rm-font-options')!.textContent).toContain('导入字体')
  })

  it('先装载字体资源再恢复服务器上的自定义字体，字体删除后恢复Maple', async () => {
    const font = { id: 'custom-' + 'a'.repeat(64), name: '导入字体', format: 'woff2' as const }
    vi.mocked(api.fonts).mockResolvedValue([font])
    vi.mocked(api.settings).mockResolvedValue({ uiFont: font.id, textFont: font.id, codeFont: font.id })
    await loadSettings()
    expect(settings.uiFont).toBe(font.id)
    expect(document.querySelector('#rm-custom-fonts')!.textContent).toContain('/api/v1/fonts/' + font.id + '/file')
    expect(document.documentElement.style.getPropertyValue('--rm-font-text')).toContain(font.id)
    vi.mocked(api.fonts).mockResolvedValue([])
    await loadSettings()
    expect(settings.uiFont).toBe('maple')
    expect(settings.textFont).toBe('maple')
    expect(settings.codeFont).toBe('maple')
  })

  it('字体保存失败后重新读取原选择并显示错误', async () => {
    vi.mocked(api.patchSettings).mockRejectedValueOnce(new ApiError(500, '字体设置写入失败'))
    ws.settings = 'appearance'
    mount(SettingsDialog)
    host!.querySelector<HTMLButtonElement>('#rm-ui-font')!.click()
    await nextTick()
    const serif = [...host!.querySelectorAll<HTMLButtonElement>('.rm-font-choice')].find(button => button.textContent === 'Noto Serif SC · 思源宋体')!
    serif.click()
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')!.textContent).toContain('字体设置写入失败'))
    expect(settings.uiFont).toBe('maple')
    expect(host!.querySelector<HTMLButtonElement>('#rm-ui-font')!.textContent).toContain('Maple')
  })

  it('删除字体失败保留原字体和设置，允许重试', async () => {
    const font = { id: 'custom-' + 'b'.repeat(64), name: '不可删除测试', format: 'woff2' as const }
    applyFontCatalog([font])
    settings.uiFont = font.id
    vi.spyOn(api, 'deleteFont').mockRejectedValueOnce(new ApiError(500, '字体删除失败'))
    ws.settings = 'appearance'
    mount(SettingsDialog)
    host!.querySelector<HTMLButtonElement>('#rm-ui-font')!.click()
    await nextTick()
    host!.querySelector<HTMLButtonElement>('button[aria-label="删除字体 不可删除测试"]')!.click()
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')!.textContent).toContain('字体删除失败'))
    expect(settings.uiFont).toBe(font.id)
    expect(host!.querySelector<HTMLButtonElement>('#rm-ui-font')!.disabled).toBe(false)
  })

  it('忽略隐藏Maple的外部设置，不允许移除默认字体', async () => {
    vi.mocked(api.settings).mockResolvedValue({ hiddenFonts: ['maple', 'serif'], uiFont: 'serif' })
    await loadSettings()
    expect(settings.hiddenFonts).toEqual(['serif'])
    expect(settings.uiFont).toBe('maple')
  })
  it('设置和命令不再提供分享入口', async () => {
    expect(searchSettings('分享')).toEqual([])
    expect(allCommands().map(command => command.id)).not.toContain('note.share')
    expect(allCommands().map(command => command.id)).not.toContain('app.shares')
    ws.settings = 'appearance'
    mount(SettingsDialog)
    expect(host!.querySelectorAll('.rm-settings-tab')).toHaveLength(8)
    expect(host!.textContent).not.toContain('分享')
  })

  it('按名称、关键词及多词匹配，只索引静态说明', () => {
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('CSS 高级')).toEqual([expect.objectContaining({ id: 'css-snippets', section: 'appearance' })])
    expect(searchSettings('api')).toEqual(expect.arrayContaining([expect.objectContaining({ section: 'account', title: 'API 令牌' }), expect.objectContaining({ id: 'openapi' })]))
    settings.cssSnippets = [{ id: 'private', name: 'private-snippet-name', enabled: true, css: ':root { --private: 1 }' }]
    expect(searchSettings('private')).toEqual([])
  })

  it('从搜索结果跳转设置行，并展开所在折叠区', async () => {
    ws.settings = 'editor'
    mount(SettingsDialog)
    await search('input[aria-label="搜索设置"]', 'CSS 高级')
    host!.querySelector<HTMLButtonElement>('.rm-settings-result')!.click()
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('rm-setting-css-snippets'))
    expect(ws.settings).toBe('appearance')
    expect(host!.querySelector<HTMLDetailsElement>('.rm-appearance-advanced')!.open).toBe(true)
    expect(host!.querySelector<HTMLInputElement>('input[aria-label="搜索设置"]')!.value).toBe('')
  })

  it('单项重置只提交对应键，不影响另一类字号，并可重新读取', async () => {
    settings.uiFontSize = 20
    settings.fontSize = 24
    settings.lineHeight = 2
    ws.settings = 'appearance'
    mount(SettingsDialog)
    host!.querySelector<HTMLButtonElement>('button[aria-label="重置界面字号"]')!.click()
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ uiFontSize: DEFAULTS.uiFontSize }))
    expect(settings.fontSize).toBe(24)
    const editor = [...host!.querySelectorAll<HTMLButtonElement>('.rm-settings-tab')].find(e => e.textContent === '编辑器')!
    editor.click()
    await nextTick()
    host!.querySelector<HTMLButtonElement>('button[aria-label="重置正文行高"]')!.click()
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenLastCalledWith({ lineHeight: DEFAULTS.lineHeight }))
    expect(settings.fontSize).toBe(24)
    vi.mocked(api.settings).mockResolvedValue({ uiFontSize: DEFAULTS.uiFontSize, fontSize: 24, lineHeight: DEFAULTS.lineHeight })
    await loadSettings()
    expect(settings.fontSize).toBe(24)
    expect(settings.lineHeight).toBe(DEFAULTS.lineHeight)
  })
})

describe('设置同步顺序', () => {
  it.each(['settings', 'fonts'] as const)('旧%s响应晚到时，不恢复已删除字体或覆盖新设置与缓存', async (delayed) => {
    const font = { id: 'custom-' + 'c'.repeat(64), name: '已删除字体', format: 'woff2' as const }
    const oldSettings = { uiFont: font.id, textFont: font.id, codeFont: font.id, fontSize: 18 }
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.settings).mockImplementationOnce(async () => {
      if (delayed === 'settings') await pending
      return oldSettings
    })
    vi.mocked(api.fonts).mockImplementationOnce(async () => {
      if (delayed === 'fonts') await pending
      return [font]
    })
    const oldLoad = loadSettings()
    vi.mocked(api.settings).mockResolvedValue({ uiFont: 'maple', textFont: 'maple', codeFont: 'maple', fontSize: 24 })
    await loadSettings()
    const cache = localStorage.getItem('rawmark.settings')
    release()
    await oldLoad
    expect(settings).toMatchObject({ uiFont: 'maple', textFont: 'maple', codeFont: 'maple', fontSize: 24 })
    expect(customFonts.value).toEqual([])
    expect(document.querySelector('#rm-custom-fonts')!.textContent).not.toContain(font.id)
    expect(document.documentElement.style.getPropertyValue('--rm-font-text')).not.toContain(font.id)
    expect(document.documentElement.style.getPropertyValue('--rm-font-size')).toBe('24px')
    expect(localStorage.getItem('rawmark.settings')).toBe(cache)
  })

  it.each(['settings', 'fonts'] as const)('本地保存完成后，迟到的旧%s响应不覆盖界面、缓存或清理期限', async delayed => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.mocked(api.settings).mockImplementationOnce(async () => {
      if (delayed === 'settings') await pending
      return { fontSize: 16, trashRetentionDays: 30 }
    })
    vi.mocked(api.fonts).mockImplementationOnce(async () => {
      if (delayed === 'fonts') await pending
      return []
    })
    const oldLoad = loadSettings()
    await updateSettings({ fontSize: 24, trashRetentionDays: 0 })
    const cache = localStorage.getItem('rawmark.settings')
    release()
    await oldLoad
    expect(settings).toMatchObject({ fontSize: 24, trashRetentionDays: 0 })
    expect(document.documentElement.style.getPropertyValue('--rm-font-size')).toBe('24px')
    expect(localStorage.getItem('rawmark.settings')).toBe(cache)
  })

  it('保存排队期间的同步等待全部已有写入，不提前读取旧配置', async () => {
    let finishFirst!: (value: Record<string, unknown>) => void
    let finishSecond!: (value: Record<string, unknown>) => void
    const pendingFirst = new Promise<Record<string, unknown>>(resolve => { finishFirst = resolve })
    const pendingSecond = new Promise<Record<string, unknown>>(resolve => { finishSecond = resolve })
    vi.mocked(api.patchSettings)
      .mockImplementationOnce(() => pendingFirst)
      .mockImplementationOnce(() => pendingSecond)
    vi.mocked(api.settings).mockResolvedValue({ fontSize: 24, trashRetentionDays: 0 })
    const first = updateSettings({ fontSize: 24 })
    const second = updateSettings({ trashRetentionDays: 0 })
    const sync = loadSettings()
    try {
      await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(1))
      expect(api.settings).not.toHaveBeenCalled()
      finishFirst({})
      await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(2))
      expect(api.settings).not.toHaveBeenCalled()
    } finally {
      finishFirst({})
      finishSecond({})
      await Promise.all([first, second, sync])
    }
    expect(api.settings).toHaveBeenCalledTimes(1)
    expect(settings).toMatchObject({ fontSize: 24, trashRetentionDays: 0 })
  })

  it('等待保存中的读取被后续本地修改作废，不回写旧设置', async () => {
    let finish!: (value: Record<string, unknown>) => void
    vi.mocked(api.patchSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = updateSettings({ fontSize: 22 })
    const sync = loadSettings()
    const second = updateSettings({ fontSize: 24 })
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(1))
    finish({})
    await Promise.all([first, second, sync])
    expect(api.settings).not.toHaveBeenCalled()
    expect(settings.fontSize).toBe(24)
  })

  it('等待中的保存失败后仍可读取服务端真值，保留原保存错误', async () => {
    let fail!: (cause: Error) => void
    vi.mocked(api.patchSettings).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    vi.mocked(api.settings).mockResolvedValue({ fontSize: 18 })
    const cause = new ApiError(500, '保存未完成')
    const write = updateSettings({ fontSize: 24 }).catch(error => error)
    const sync = loadSettings()
    await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
    fail(cause)
    expect(await write).toBe(cause)
    await sync
    expect(settings.fontSize).toBe(18)
    expect(settingsSave).toMatchObject({ pending: 0, result: 'error', error: cause.message })
  })

  it('最新同步失败仍报告原错误，迟到旧响应不会覆盖当前状态，后续可重新同步', async () => {
    let release!: (value: Record<string, unknown>) => void
    vi.mocked(api.settings).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const oldLoad = loadSettings()
    const cause = new ApiError(503, '字体列表暂时不可用')
    vi.mocked(api.fonts).mockRejectedValueOnce(cause)
    await expect(loadSettings()).rejects.toBe(cause)
    release({ fontSize: 18 })
    await oldLoad
    expect(settings.fontSize).toBe(DEFAULTS.fontSize)
    vi.mocked(api.settings).mockResolvedValue({ fontSize: 24 })
    await loadSettings()
    expect(settings.fontSize).toBe(24)
  })
})

describe('保存反馈', () => {
  it('所有排队请求完成之前保留保存中，不提前发送后续请求', async () => {
    let finish!: (value: Record<string, unknown>) => void
    vi.mocked(api.patchSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = updateSettings({ uiFontSize: 18 })
    const second = updateSettings({ fontSize: 22 })
    expect(settingsSave.pending).toBe(2)
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledTimes(1))
    expect(settingsSave.result).toBe('idle')
    finish({})
    await Promise.all([first, second])
    expect(api.patchSettings).toHaveBeenNthCalledWith(2, { fontSize: 22 })
    expect(settingsSave).toMatchObject({ pending: 0, result: 'saved', error: '' })
  })

  it('失败可见，重新读取不冒充保存成功，后续保存仍可执行', async () => {
    vi.mocked(api.patchSettings).mockRejectedValueOnce(new ApiError(500, '写入失败'))
    await expect(updateSettings({ uiFontSize: 18 })).rejects.toThrow('写入失败')
    expect(settingsSave).toMatchObject({ pending: 0, result: 'error', error: '写入失败' })
    await loadSettings()
    expect(settingsSave.result).toBe('error')
    await updateSettings({ uiFontSize: 16 })
    expect(settingsSave).toMatchObject({ pending: 0, result: 'saved', error: '' })
  })

  it('写入成功但主题加载失败，保留保存结果和原始错误', async () => {
    const cause = new ApiError(503, '主题暂时不可用')
    vi.spyOn(api, 'theme').mockRejectedValueOnce(cause)
    const failure = await updateSettings({ theme: 'unavailable' }).catch(error => error)
    expect(failure).toBeInstanceOf(SettingsAppearanceError)
    expect(failure.cause).toBe(cause)
    expect(failure.message).toContain('设置已保存，但主题应用失败')
    expect(settingsSave).toMatchObject({ pending: 0, result: 'saved' })
  })

  it('CSS 已写入但主题应用失败时结束编辑，不把成功的写入留作重试', async () => {
    settings.theme = 'broken-theme'
    vi.spyOn(api, 'theme').mockRejectedValue(new ApiError(503, '主题暂时不可用'))
    ws.settings = 'appearance'
    mount(SettingsDialog)
    host!.querySelector<HTMLDetailsElement>('.rm-appearance-advanced')!.open = true
    const add = [...host!.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent === '新建片段')!
    add.click()
    await nextTick()
    await search('input[aria-label="片段名称"]', '主题失败时的片段')
    const css = host!.querySelector<HTMLTextAreaElement>('textarea')!
    css.value = ':root { --test-marker: 1; }'
    css.dispatchEvent(new Event('input', { bubbles: true }))
    host!.querySelector<HTMLFormElement>('.rm-snippet-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(host!.querySelector('.rm-snippet-form')).toBeNull())
    expect(settings.cssSnippets).toHaveLength(1)
    expect(api.patchSettings).toHaveBeenCalledTimes(1)
    expect(settingsSave.result).toBe('saved')
  })
})

describe('快捷键查找', () => {
  it('过滤列表后仍检查隐藏命令的冲突，可按 ID 和组合键查找', async () => {
    const occupied = { id: 'plugin:settings-test:hidden', title: '隐藏占用命令', keys: ['Mod+Alt+Shift+9'], run() {} }
    cleanup.push(registerCommand({ id: 'settings-test.target', title: '审查定位命令', run() {} }), registerCommand(occupied))
    mount(ShortcutSettings)
    await search('input[aria-label="搜索快捷键"]', '审查定位命令')
    expect(host!.querySelectorAll('.rm-shortcut-row')).toHaveLength(1)
    const add = [...host!.querySelectorAll<HTMLButtonElement>('.rm-shortcut-row button')].find(e => e.textContent === '添加')!
    add.click()
    await nextTick()
    host!.querySelector('[data-shortcut-recorder]')!.dispatchEvent(new KeyboardEvent('keydown', { key: '9', code: 'Digit9', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    await nextTick()
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('隐藏占用命令')
    expect(api.patchSettings).not.toHaveBeenCalled()
    await search('input[aria-label="搜索快捷键"]', 'plugin:settings-test:hidden')
    expect(host!.querySelectorAll('.rm-shortcut-row')).toHaveLength(1)
    expect(host!.querySelector('[data-shortcut-recorder]')).toBeNull()
    await search('input[aria-label="搜索快捷键"]', formatKeys(commandKeys(occupied)[0]))
    expect(host!.textContent).toContain('隐藏占用命令')
    await search('input[aria-label="搜索快捷键"]', '不存在的命令')
    expect(host!.querySelectorAll('.rm-shortcut-row')).toHaveLength(0)
    expect(host!.textContent).toContain('没有匹配的快捷键')
  })
})

describe('应用存储与回收站', () => {
  const usage = { totalSize: 1024, categories: [{ id: 'vault' as const, size: 1024 }], builtinFontsSize: 0, customFontsSize: 0, assetsSize: 512, trashSize: 256, calculatedAt: 1700000000000 }
  it('进入页面自动统计，防重复请求，刷新失败保留上次结果并展示错误', async () => {
    let resolve!: (value: typeof usage) => void
    const storage = vi.spyOn(api, 'storage').mockImplementationOnce(() => new Promise(done => { resolve = done }))
    ws.settings = 'storage'
    mount(SettingsDialog)
    expect(storage).toHaveBeenCalledTimes(1)
    const button = host!.querySelector<HTMLButtonElement>('#rm-setting-storage button')!
    button.click()
    await nextTick()
    expect(button.disabled).toBe(true)
    button.click()
    expect(storage).toHaveBeenCalledTimes(1)
    resolve(usage)
    await vi.waitFor(() => expect(host!.textContent).toContain('1 KiB'))
    expect(host!.textContent).toContain('附件')
    storage.mockRejectedValueOnce(new Error('磁盘读取错误'))
    button.click()
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')?.textContent).toContain('磁盘读取错误'))
    expect(host!.textContent).toContain('1 KiB')
  })

  it('维护重置取消时不发送请求，确认时等待保存并保留真实失败', async () => {
    vi.spyOn(api, 'storage').mockResolvedValue(usage)
    const reset = vi.spyOn(api, 'resetSettings').mockRejectedValue(new Error('backup disk full'))
    vi.stubGlobal('confirm', vi.fn().mockReturnValueOnce(false).mockReturnValue(true))
    ws.settings = 'storage'; mount(SettingsDialog)
    const button = host!.querySelector<HTMLButtonElement>('#rm-setting-settings-reset button')!
    button.click(); expect(reset).not.toHaveBeenCalled()
    button.click()
    await vi.waitFor(() => expect(host!.textContent).toContain('backup disk full'))
    expect(reset).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(false)
  })
  it('清空必须确认；防止重复操作，部分失败后重读并保留错误详情', async () => {
    const item = { id: 'one', path: 'broken.md', dir: false, deletedAt: Date.now() }
    vi.spyOn(api, 'trash').mockResolvedValue([item])
    let finish!: (value: { deleted: string[]; failed: { id: string; error: string }[] }) => void
    const clear = vi.spyOn(api, 'clearTrash').mockImplementation(() => new Promise(done => { finish = done }))
    const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    vi.stubGlobal('confirm', confirm)
    ws.settings = 'trash'
    mount(SettingsDialog)
    await vi.waitFor(() => expect(host!.textContent).toContain('broken'))
    const button = host!.querySelector<HTMLButtonElement>('#rm-setting-trash-clear button')!
    button.click()
    expect(clear).not.toHaveBeenCalled()
    button.click()
    await nextTick()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(button.disabled).toBe(true)
    expect([...host!.querySelectorAll<HTMLButtonElement>('.rm-trash-list button')].every(b => b.disabled)).toBe(true)
    button.click()
    expect(clear).toHaveBeenCalledTimes(1)
    finish({ deleted: [], failed: [{ id: item.id, error: '元数据损坏' }] })
    await vi.waitFor(() => expect(host!.querySelector('[role="alert"]')?.textContent).toContain('元数据损坏'))
    expect(api.trash).toHaveBeenCalledTimes(2)
    expect(button.disabled).toBe(false)
  })
  it('保留天数支持0，拒绝负数和小数，不提交无效值', async () => {
    vi.spyOn(api, 'trash').mockResolvedValue([])
    ws.settings = 'trash'
    mount(SettingsDialog)
    const input = host!.querySelector<HTMLInputElement>('#rm-trash-retention')!
    expect(input.value).toBe('30')
    for (const value of ['-1', '1.5', '']) {
      input.value = value
      input.dispatchEvent(new Event('change', { bubbles: true }))
      expect(api.patchSettings).not.toHaveBeenCalled()
      expect(input.value).toBe('30')
    }
    input.value = '0'
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(api.patchSettings).toHaveBeenCalledWith({ trashRetentionDays: 0 }))
    expect(settings.trashRetentionDays).toBe(0)
  })
})
