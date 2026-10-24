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

let app: App | undefined
let host: HTMLElement | undefined
const cleanup: (() => void)[] = []
beforeEach(() => {
  Object.assign(settings, DEFAULTS, { colorMode: 'system', theme: 'default', cssSnippets: [], shortcuts: {} })
  Object.assign(settingsSave, { pending: 0, result: 'idle', error: '' })
  vi.spyOn(api, 'patchSettings').mockResolvedValue({})
  vi.spyOn(api, 'settings').mockResolvedValue({})
  vi.spyOn(api, 'themes').mockResolvedValue([{ id: 'default', name: '默认', version: '1' }])
})
afterEach(() => {
  app?.unmount()
  app = undefined
  host?.remove()
  cleanup.splice(0).forEach(fn => fn())
  ws.settings = null
  vi.restoreAllMocks()
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
  it('设置和命令不再提供分享入口', async () => {
    expect(searchSettings('分享')).toEqual([])
    expect(allCommands().map(command => command.id)).not.toContain('note.share')
    expect(allCommands().map(command => command.id)).not.toContain('app.shares')
    ws.settings = 'appearance'
    mount(SettingsDialog)
    expect(host!.querySelectorAll('.rm-settings-tab')).toHaveLength(9)
    expect(host!.textContent).not.toContain('分享')
  })

  it('按名称、关键词及多词匹配，只索引静态说明', () => {
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('CSS 高级')).toEqual([expect.objectContaining({ id: 'css-snippets', section: 'appearance' })])
    expect(searchSettings('api')).toEqual(expect.arrayContaining([expect.objectContaining({ section: 'tokens', title: 'API 令牌' }), expect.objectContaining({ id: 'openapi' })]))
    settings.dailyFolder = 'private-note-folder'
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
