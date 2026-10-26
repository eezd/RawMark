import type { App } from 'vue'
import * as fontsApi from '@@/apis/fonts'
import * as maintenanceApi from '@@/apis/maintenance'
import * as settingsApi from '@@/apis/settings'
import * as storageApi from '@@/apis/storage'
import * as themesApi from '@@/apis/themes'
import * as tokensApi from '@@/apis/tokens'
import * as trashApi from '@@/apis/trash'
import { applyLocale, chooseAnonymousLocale, locale } from '@@/i18n/runtime'
import { confirmAction } from '@@/utils/confirm'
import { toasts } from '@@/utils/notifications'
import { flushPromises } from '@vue/test-utils'

import { CanceledError, isCancel } from 'axios'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// @vitest-environment happy-dom
import { createApp, defineComponent, h, nextTick } from 'vue'
import { ApiError } from '@/http/axios'
import { useSettingsChange } from '@/pages/settings/composables/use-settings-change'
import { pinia } from '@/pinia'

import { apiSuccess } from '../../../tests/api-response'
import { applyFontCatalog, customFonts } from '../../common/appearance/fonts'
import { allCommands, commandKeys, formatKeys, registerCommand } from '../../common/utils/commands'
import ShortcutSettings from '../../pages/settings/components/ShortcutSettings.vue'
import SettingsDialog from '../../pages/settings/index.vue'
import { searchSettings } from '../../pages/settings/settings-catalog'
import { ws } from '../../pages/workspace/workspace'
import { DEFAULTS, SettingsAppearanceError, useSettingsStore } from './settings'

const { loadSettings, settings, settingsSave, updateSettings } = useSettingsStore(pinia)

vi.mock('@@/utils/confirm', () => ({ confirmAction: vi.fn() }))

let app: App | undefined
let host: HTMLElement | undefined
const cleanup: (() => void)[] = []
beforeEach(() => {
  applyLocale('en')
  setActivePinia(pinia)
  vi.mocked(confirmAction).mockResolvedValue(true)
  applyFontCatalog([])
  Object.assign(settings, DEFAULTS, { colorMode: 'system', theme: 'default', cssSnippets: [], shortcuts: {} })
  Object.assign(settingsSave, { pending: 0, result: 'idle', error: '' })
  vi.spyOn(settingsApi, 'patchSettingsApi').mockResolvedValue(apiSuccess({}))
  vi.spyOn(settingsApi, 'getSettingsApi').mockResolvedValue(apiSuccess({}))
  vi.spyOn(fontsApi, 'getFontsApi').mockResolvedValue(apiSuccess({ fonts: [] }))
  vi.spyOn(maintenanceApi, 'getMaintenanceStatusApi').mockResolvedValue(apiSuccess({ busy: false, operation: '', error: '', finishedAt: 0 }))
  vi.spyOn(themesApi, 'getThemesApi').mockResolvedValue(apiSuccess({ themes: [{ id: 'default', name: 'Default', version: '1' }] }))
})
afterEach(async () => {
  app?.unmount()
  await flushPromises()
  app = undefined
  host?.remove()
  cleanup.splice(0).forEach(fn => fn())
  ws.settings = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
async function mount(component: typeof SettingsDialog | typeof ShortcutSettings) {
  host = document.createElement('div')
  document.body.append(host)
  app = component === SettingsDialog
    ? createApp(defineComponent(() => () => h(SettingsDialog, { 'modelValue': ws.settings, 'onUpdate:modelValue': (value) => {
        ws.settings = value
      }, 'prepareMaintenance': async () => {}, 'restoreNote': async () => {} })))
    : createApp(component)
  app.mount(host)
  await flushPromises()
}
async function search(selector: string, query: string) {
  const input = document.body.querySelector<HTMLInputElement>(selector)!
  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('设置查找与重置', () => {
  it('分类按约定排序，令牌归入账户与安全', async () => {
    ws.settings = 'account'
    vi.spyOn(tokensApi, 'getTokensApi').mockResolvedValue(apiSuccess({ tokens: [] }))
    await mount(SettingsDialog)
    expect([...document.body.querySelectorAll('.rm-settings-tab')].map(el => el.textContent)).toEqual(['Appearance', 'Editor', 'Shortcuts', 'Plugins', 'Storage', 'Trash', 'Account and security', 'About'])
    await vi.waitFor(() => expect(document.body.querySelector('#rm-setting-tokens')).not.toBeNull())
    expect(searchSettings('API tokens')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'tokens', section: 'account' })]))
  })

  it('编辑器字号在输入时立即生效，无需回车或失焦', async () => {
    ws.settings = 'editor'
    await mount(SettingsDialog)
    const input = document.body.querySelector<HTMLInputElement>('#rm-font-size')!
    input.value = '24'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(settings.fontSize).toBe(24)
    expect(document.documentElement.style.getPropertyValue('--rm-font-size')).toBe('24px')
    await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledWith({ fontSize: 24 }))
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    expect(settings.fontSize).toBe(24)
    input.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(input.value).toBe('24')
  })

  it('移除日记和模板设置、搜索与命令入口', async () => {
    expect(searchSettings('日记')).toEqual([])
    expect(searchSettings('Calendar')).toEqual([])
    expect(DEFAULTS).not.toHaveProperty('dailyFolder')
    expect(searchSettings('模板')).toEqual([])
    expect(DEFAULTS).not.toHaveProperty('templatesFolder')
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    expect(document.body.textContent).not.toContain('日记')
    expect(document.body.querySelector('#rm-templates-folder')).toBeNull()
    expect(document.body.textContent).not.toContain('模板')
  })

  it('界面与编辑器共用字体管理，删除预设同步恢复使用位置，Maple不可删除', async () => {
    settings.uiFont = settings.textFont = settings.codeFont = 'serif'
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    document.body.querySelector<HTMLButtonElement>('#rm-ui-font')!.click()
    await nextTick()
    expect(document.body.querySelector('button[aria-label^="Delete font Maple"]')).toBeNull()
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Delete font Noto Serif SC · Serif"]')!.click()
    await vi.waitFor(() => expect(settings.hiddenFonts).toContain('serif'))
    expect(settings.uiFont).toBe('maple')
    expect(settings.textFont).toBe('maple')
    expect(settings.codeFont).toBe('maple')
    const editor = [...document.body.querySelectorAll<HTMLButtonElement>('.rm-settings-tab')].find(button => button.textContent?.trim() === 'Editor')!
    editor.click()
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('#rm-text-font')!.click()
    await nextTick()
    expect(document.body.querySelector('.rm-font-options')!.textContent).not.toContain('Noto Serif SC')
    expect(document.body.querySelector('.rm-font-options')!.textContent).toContain('Import font')
  })

  it('先装载字体资源再恢复服务器上的自定义字体，字体删除后恢复Maple', async () => {
    const font = { id: `custom-${'a'.repeat(64)}`, name: 'Import font', format: 'woff2' as const }
    vi.mocked(fontsApi.getFontsApi).mockResolvedValue(apiSuccess({ fonts: [font] }))
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ uiFont: font.id, textFont: font.id, codeFont: font.id }))
    await loadSettings()
    expect(settings.uiFont).toBe(font.id)
    expect(document.querySelector('#rm-custom-fonts')!.textContent).toContain(`/api/v1/resources/test-fonts/fonts/${font.id}/file`)
    expect(document.documentElement.style.getPropertyValue('--rm-font-text')).toContain(font.id)
    vi.mocked(fontsApi.getFontsApi).mockResolvedValue(apiSuccess({ fonts: [] }))
    await loadSettings()
    expect(settings.uiFont).toBe('maple')
    expect(settings.textFont).toBe('maple')
    expect(settings.codeFont).toBe('maple')
  })

  it('字体保存失败后重新读取原选择并显示错误', async () => {
    vi.mocked(settingsApi.patchSettingsApi).mockRejectedValueOnce(new ApiError(500, '字体设置写入失败'))
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    document.body.querySelector<HTMLButtonElement>('#rm-ui-font')!.click()
    await nextTick()
    const serif = [...document.body.querySelectorAll<HTMLButtonElement>('.el-select-dropdown__item')].find(button => button.textContent?.trim() === 'Noto Serif SC · Serif')!
    serif.click()
    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')!.textContent).toContain('字体设置写入失败'))
    expect(settings.uiFont).toBe('maple')
    expect(document.body.querySelector('#rm-ui-font')!.closest('.el-select')!.textContent).toContain('Maple')
  })

  it('删除字体失败保留原字体和设置，允许重试', async () => {
    const font = { id: `custom-${'b'.repeat(64)}`, name: '不可删除测试', format: 'woff2' as const }
    applyFontCatalog([font])
    settings.uiFont = font.id
    vi.spyOn(fontsApi, 'deleteFontApi').mockRejectedValueOnce(new ApiError(500, '字体删除失败'))
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    document.body.querySelector<HTMLButtonElement>('#rm-ui-font')!.click()
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Delete font 不可删除测试"]')!.click()
    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')!.textContent).toContain('字体删除失败'))
    expect(settings.uiFont).toBe(font.id)
    expect(document.body.querySelector<HTMLButtonElement>('#rm-ui-font')!.disabled).toBe(false)
  })

  it('忽略隐藏Maple的外部设置，不允许移除默认字体', async () => {
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ hiddenFonts: ['maple', 'serif'], uiFont: 'serif' }))
    await loadSettings()
    expect(settings.hiddenFonts).toEqual(['serif'])
    expect(settings.uiFont).toBe('maple')
  })
  it('设置和命令不再提供分享入口', async () => {
    expect(searchSettings('分享')).toEqual([])
    expect(allCommands().map(command => command.id)).not.toContain('note.share')
    expect(allCommands().map(command => command.id)).not.toContain('app.shares')
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    expect(document.body.querySelectorAll('.rm-settings-tab')).toHaveLength(8)
    expect(document.body.textContent).not.toContain('分享')
  })

  it('按名称、关键词及多词匹配，只索引静态说明', () => {
    expect(searchSettings('   ')).toEqual([])
    expect(searchSettings('CSS advanced')).toEqual([expect.objectContaining({ id: 'css-snippets', section: 'appearance' })])
    expect(searchSettings('api')).toEqual(expect.arrayContaining([expect.objectContaining({ section: 'account', title: 'API tokens' }), expect.objectContaining({ id: 'openapi' })]))
    settings.cssSnippets = [{ id: 'private', name: 'private-snippet-name', enabled: true, css: ':root { --private: 1 }' }]
    expect(searchSettings('private')).toEqual([])
  })

  it('从搜索结果跳转设置行，并展开所在折叠区', async () => {
    ws.settings = 'editor'
    await mount(SettingsDialog)
    await search('input[aria-label="Search settings"]', 'CSS advanced')
    document.body.querySelector<HTMLButtonElement>('.rm-settings-result')!.click()
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('rm-setting-css-snippets'))
    expect(ws.settings).toBe('appearance')
    expect(document.body.querySelector<HTMLDetailsElement>('.rm-appearance-advanced')!.open).toBe(true)
    expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!.value).toBe('')
  })

  it('单项重置只提交对应键，不影响另一类字号，并可重新读取', async () => {
    settings.uiFontSize = 20
    settings.fontSize = 24
    settings.lineHeight = 2
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Reset Interface font size"]')!.click()
    await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledWith({ uiFontSize: DEFAULTS.uiFontSize }))
    expect(settings.fontSize).toBe(24)
    const editor = [...document.body.querySelectorAll<HTMLButtonElement>('.rm-settings-tab')].find(e => e.textContent?.trim() === 'Editor')!
    editor.click()
    await nextTick()
    document.body.querySelector<HTMLButtonElement>('button[aria-label="Reset Body line height"]')!.click()
    await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenLastCalledWith({ lineHeight: DEFAULTS.lineHeight }))
    expect(settings.fontSize).toBe(24)
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ uiFontSize: DEFAULTS.uiFontSize, fontSize: 24, lineHeight: DEFAULTS.lineHeight }))
    await loadSettings()
    expect(settings.fontSize).toBe(24)
    expect(settings.lineHeight).toBe(DEFAULTS.lineHeight)
  })
})

describe('设置同步顺序', () => {
  it.each(['settings', 'fonts'] as const)('旧%s响应晚到时，不恢复已删除字体或覆盖新设置与缓存', async (delayed) => {
    const font = { id: `custom-${'c'.repeat(64)}`, name: '已删除字体', format: 'woff2' as const }
    const oldSettings = { uiFont: font.id, textFont: font.id, codeFont: font.id, fontSize: 18 }
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(settingsApi.getSettingsApi).mockImplementationOnce(async () => {
      if (delayed === 'settings') await pending
      return apiSuccess(await (oldSettings))
    })
    vi.mocked(fontsApi.getFontsApi).mockImplementationOnce(async () => {
      if (delayed === 'fonts') await pending
      return apiSuccess({ fonts: await ([font]) })
    })
    const oldLoad = loadSettings()
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ uiFont: 'maple', textFont: 'maple', codeFont: 'maple', fontSize: 24 }))
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

  it.each(['settings', 'fonts'] as const)('本地保存完成后，迟到的旧%s响应不覆盖界面、缓存或清理期限', async (delayed) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(settingsApi.getSettingsApi).mockImplementationOnce(async () => {
      if (delayed === 'settings') await pending
      return apiSuccess(await ({ fontSize: 16, trashRetentionDays: 30 }))
    })
    vi.mocked(fontsApi.getFontsApi).mockImplementationOnce(async () => {
      if (delayed === 'fonts') await pending
      return apiSuccess({ fonts: await ([]) })
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
    const pendingFirst = new Promise<Record<string, unknown>>((resolve) => {
      finishFirst = resolve
    })
    const pendingSecond = new Promise<Record<string, unknown>>((resolve) => {
      finishSecond = resolve
    })
    vi.mocked(settingsApi.patchSettingsApi)
      .mockImplementationOnce(() => (pendingFirst).then(value => apiSuccess(value)))
      .mockImplementationOnce(() => pendingSecond.then(value => apiSuccess(value)))
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ fontSize: 24, trashRetentionDays: 0 }))
    const first = updateSettings({ fontSize: 24 })
    const second = updateSettings({ trashRetentionDays: 0 })
    const sync = loadSettings()
    try {
      await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledTimes(1))
      expect(settingsApi.getSettingsApi).not.toHaveBeenCalled()
      finishFirst({})
      await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledTimes(2))
      expect(settingsApi.getSettingsApi).not.toHaveBeenCalled()
    } finally {
      finishFirst({})
      finishSecond({})
      await Promise.all([first, second, sync])
    }
    expect(settingsApi.getSettingsApi).toHaveBeenCalledTimes(1)
    expect(settings).toMatchObject({ fontSize: 24, trashRetentionDays: 0 })
  })

  it('等待保存中的读取被后续本地修改作废，不回写旧设置', async () => {
    let finish!: (value: Record<string, unknown>) => void
    vi.mocked(settingsApi.patchSettingsApi).mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof settingsApi.patchSettingsApi>>['data']>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess(value)))
    const first = updateSettings({ fontSize: 22 })
    const sync = loadSettings()
    const second = updateSettings({ fontSize: 24 })
    await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledTimes(1))
    finish({})
    await Promise.all([first, second, sync])
    expect(settingsApi.getSettingsApi).not.toHaveBeenCalled()
    expect(settings.fontSize).toBe(24)
  })

  it('等待中的保存失败后仍可读取服务端真值，保留原保存错误', async () => {
    let fail!: (cause: Error) => void
    vi.mocked(settingsApi.patchSettingsApi).mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof settingsApi.patchSettingsApi>>['data']>((_resolve, reject) => {
      fail = reject
    })).then(value => apiSuccess(value)))
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ fontSize: 18 }))
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
    vi.mocked(settingsApi.getSettingsApi).mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof settingsApi.getSettingsApi>>['data']>((resolve) => {
      release = resolve
    })).then(value => apiSuccess(value)))
    const oldLoad = loadSettings()
    const cause = new ApiError(503, '字体列表暂时不可用')
    vi.mocked(fontsApi.getFontsApi).mockRejectedValueOnce(cause)
    await expect(loadSettings()).rejects.toBe(cause)
    release({ fontSize: 18 })
    await oldLoad
    expect(settings.fontSize).toBe(DEFAULTS.fontSize)
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValue(apiSuccess({ fontSize: 24 }))
    await loadSettings()
    expect(settings.fontSize).toBe(24)
  })
})

describe('保存反馈', () => {
  it('所有排队请求完成之前保留保存中，不提前发送后续请求', async () => {
    let finish!: (value: Record<string, unknown>) => void
    vi.mocked(settingsApi.patchSettingsApi).mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof settingsApi.patchSettingsApi>>['data']>((resolve) => {
      finish = resolve
    })).then(value => apiSuccess(value)))
    const first = updateSettings({ uiFontSize: 18 })
    const second = updateSettings({ fontSize: 22 })
    expect(settingsSave.pending).toBe(2)
    await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledTimes(1))
    expect(settingsSave.result).toBe('idle')
    finish({})
    await Promise.all([first, second])
    expect(settingsApi.patchSettingsApi).toHaveBeenNthCalledWith(2, { fontSize: 22 })
    expect(settingsSave).toMatchObject({ pending: 0, result: 'saved', error: '' })
  })

  it('失败可见，重新读取不冒充保存成功，后续保存仍可执行', async () => {
    vi.mocked(settingsApi.patchSettingsApi).mockRejectedValueOnce(new ApiError(500, '写入失败'))
    await expect(updateSettings({ uiFontSize: 18 })).rejects.toThrow('写入失败')
    expect(settingsSave).toMatchObject({ pending: 0, result: 'error', error: '写入失败' })
    await loadSettings()
    expect(settingsSave.result).toBe('error')
    await updateSettings({ uiFontSize: 16 })
    expect(settingsSave).toMatchObject({ pending: 0, result: 'saved', error: '' })
  })

  it('写入成功但主题加载失败，保留保存结果和原始错误', async () => {
    const cause = new ApiError(503, '主题暂时不可用')
    vi.spyOn(themesApi, 'getThemeApi').mockRejectedValueOnce(cause)
    const failure = await updateSettings({ theme: 'unavailable' }).catch(error => error)
    expect(failure).toBeInstanceOf(SettingsAppearanceError)
    expect(failure.cause).toBe(cause)
    expect(failure.message).toContain('Settings saved, but the theme could not be applied')
    expect(settingsSave).toMatchObject({ pending: 0, result: 'saved' })
  })

  it('取消的主题读取保留取消语义，不伪装成主题应用失败', async () => {
    vi.spyOn(themesApi, 'getThemeApi').mockRejectedValueOnce(new CanceledError('Session changed'))
    const failure = await updateSettings({ theme: 'cancelled-theme' }).catch(error => error)
    expect(isCancel(failure)).toBe(true)
    expect(failure).not.toBeInstanceOf(SettingsAppearanceError)
  })

  it('失效会话的设置保存取消后不弹错误或启动新会话的回退读取', async () => {
    vi.mocked(settingsApi.patchSettingsApi).mockRejectedValueOnce(new CanceledError('Session changed'))
    ws.settings = 'editor'
    await mount(SettingsDialog)
    toasts.splice(0)
    const input = document.body.querySelector<HTMLInputElement>('#rm-font-size')!
    input.value = '24'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await vi.waitFor(() => expect(settingsSave.pending).toBe(0))
    expect(toasts).toHaveLength(0)
    expect(settingsApi.getSettingsApi).not.toHaveBeenCalled()
  })

  it('cSS 已写入但主题应用失败时结束编辑，不把成功的写入留作重试', async () => {
    settings.theme = 'broken-theme'
    vi.spyOn(themesApi, 'getThemeApi').mockRejectedValue(new ApiError(503, '主题暂时不可用'))
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    document.body.querySelector<HTMLDetailsElement>('.rm-appearance-advanced')!.open = true
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(e => e.textContent?.trim() === 'New snippet')!
    add.click()
    await nextTick()
    await search('input[aria-label="Snippet name"]', '主题失败时的片段')
    const css = document.body.querySelector<HTMLTextAreaElement>('textarea')!
    css.value = ':root { --test-marker: 1; }'
    css.dispatchEvent(new Event('input', { bubbles: true }))
    document.body.querySelector<HTMLFormElement>('.rm-snippet-form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(document.body.querySelector('.rm-snippet-form')).toBeNull())
    expect(settings.cssSnippets).toHaveLength(1)
    expect(settingsApi.patchSettingsApi).toHaveBeenCalledTimes(1)
    expect(settingsSave.result).toBe('saved')
  })
})

describe('快捷键查找', () => {
  it('过滤列表后仍检查隐藏命令的冲突，可按 ID 和组合键查找', async () => {
    const occupied = { id: 'plugin:settings-test:hidden', title: '隐藏占用命令', keys: ['Mod+Alt+Shift+9'], run() {} }
    cleanup.push(registerCommand({ id: 'settings-test.target', title: '审查定位命令', run() {} }), registerCommand(occupied))
    await mount(ShortcutSettings)
    await search('input[aria-label="Search shortcuts"]', '审查定位命令')
    expect(document.body.querySelectorAll('.rm-shortcut-row')).toHaveLength(1)
    const add = [...document.body.querySelectorAll<HTMLButtonElement>('.rm-shortcut-row button')].find(e => e.textContent?.trim() === 'Add')!
    add.click()
    await nextTick()
    document.body.querySelector('[data-shortcut-recorder]')!.dispatchEvent(new KeyboardEvent('keydown', { key: '9', code: 'Digit9', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    await nextTick()
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain('隐藏占用命令')
    expect(settingsApi.patchSettingsApi).not.toHaveBeenCalled()
    await search('input[aria-label="Search shortcuts"]', 'plugin:settings-test:hidden')
    expect(document.body.querySelectorAll('.rm-shortcut-row')).toHaveLength(1)
    expect(document.body.querySelector('[data-shortcut-recorder]')).toBeNull()
    await search('input[aria-label="Search shortcuts"]', formatKeys(commandKeys(occupied)[0]))
    expect(document.body.textContent).toContain('隐藏占用命令')
    await search('input[aria-label="Search shortcuts"]', '不存在的命令')
    expect(document.body.querySelectorAll('.rm-shortcut-row')).toHaveLength(0)
    expect(document.body.textContent).toContain('no matching shortcuts')
  })
})

describe('应用存储与回收站', () => {
  const usage = { totalSize: 1024, categories: [{ id: 'vault' as const, size: 1024 }], builtinFontsSize: 0, customFontsSize: 0, assetsSize: 512, trashSize: 256, calculatedAt: 1700000000000 }
  it('进入页面自动统计，防重复请求，刷新失败保留上次结果并展示错误', async () => {
    let resolve!: (value: typeof usage) => void
    const storage = vi.spyOn(storageApi, 'getStorageApi').mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof storageApi.getStorageApi>>['data']>((done) => {
      resolve = done
    })).then(value => apiSuccess(value)))
    ws.settings = 'storage'
    await mount(SettingsDialog)
    expect(storage).toHaveBeenCalledTimes(1)
    const button = document.body.querySelector<HTMLButtonElement>('#rm-setting-storage button')!
    button.click()
    await nextTick()
    expect(button.disabled).toBe(true)
    button.click()
    expect(storage).toHaveBeenCalledTimes(1)
    resolve(usage)
    await vi.waitFor(() => expect(document.body.textContent).toContain('1 KiB'))
    expect(document.body.textContent).toContain('Attachments')
    storage.mockRejectedValueOnce(new Error('磁盘读取错误'))
    button.click()
    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('磁盘读取错误'))
    expect(document.body.textContent).toContain('1 KiB')
  })

  it('维护重置取消时不发送请求，确认时等待保存并保留真实失败', async () => {
    vi.spyOn(storageApi, 'getStorageApi').mockResolvedValue(apiSuccess(usage))
    const reset = vi.spyOn(maintenanceApi, 'resetSettingsApi').mockRejectedValue(new Error('backup disk full'))
    vi.mocked(confirmAction).mockResolvedValueOnce(false).mockResolvedValue(true)
    ws.settings = 'storage'; await mount(SettingsDialog)
    const button = document.body.querySelector<HTMLButtonElement>('#rm-setting-settings-reset button')!
    button.click(); await flushPromises(); expect(reset).not.toHaveBeenCalled()
    button.click()
    await vi.waitFor(() => expect(document.body.textContent).toContain('backup disk full'))
    expect(reset).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(false)
  })
  it('清空必须确认；防止重复操作，部分失败后重读并保留错误详情', async () => {
    const item = { id: 'one', path: 'broken.md', dir: false, deletedAt: Date.now() }
    vi.spyOn(trashApi, 'getTrashApi').mockResolvedValue(apiSuccess({ items: [item] }))
    let finish!: (value: { deleted: string[], failed: { id: string, error: string }[] }) => void
    const clear = vi.spyOn(trashApi, 'clearTrashApi').mockImplementation(() => (new Promise<Awaited<ReturnType<typeof trashApi.clearTrashApi>>['data']>((done) => {
      finish = done
    })).then(value => apiSuccess(value)))
    const confirm = vi.mocked(confirmAction).mockResolvedValueOnce(false).mockResolvedValue(true)
    ws.settings = 'trash'
    await mount(SettingsDialog)
    await vi.waitFor(() => expect(document.body.textContent).toContain('broken'))
    const button = document.body.querySelector<HTMLButtonElement>('#rm-setting-trash-clear button')!
    button.click()
    await flushPromises()
    expect(clear).not.toHaveBeenCalled()
    button.click()
    await nextTick()
    expect(confirm).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(button.disabled).toBe(true))
    expect([...document.body.querySelectorAll<HTMLButtonElement>('.el-table button')].every(b => b.disabled)).toBe(true)
    button.click()
    expect(clear).toHaveBeenCalledTimes(1)
    finish({ deleted: [], failed: [{ id: item.id, error: '元数据损坏' }] })
    await vi.waitFor(() => expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('元数据损坏'))
    expect(trashApi.getTrashApi).toHaveBeenCalledTimes(2)
    expect(button.disabled).toBe(false)
  })
  it('保留天数支持0，拒绝负数和小数，不提交无效值', async () => {
    vi.spyOn(trashApi, 'getTrashApi').mockResolvedValue(apiSuccess({ items: [] }))
    ws.settings = 'trash'
    await mount(SettingsDialog)
    const input = document.body.querySelector<HTMLInputElement>('#rm-trash-retention')!
    expect(input.value).toBe('30')
    for (const value of ['-1', '1.5', '']) {
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await nextTick()
      expect(settingsApi.patchSettingsApi).not.toHaveBeenCalled()
      expect(input.value).toBe('30')
    }
    input.value = '0'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(settingsApi.patchSettingsApi).toHaveBeenCalledWith({ trashRetentionDays: 0 }))
    expect(settings.trashRetentionDays).toBe(0)
  })
})

vi.mock('@@/utils/resource-tickets', () => ({
  prepareResources: async () => {},
  imageResourceRoot: () => '/api/v1/resources/test-images/images/',
  fontResourceRoot: () => '/api/v1/resources/test-fonts/fonts/',
  pluginResourceURL: async (id: string, revision: string) => `/api/v1/resources/test-plugin/plugin/plugins/${id}/assets/${revision}/main.js`,
}))

it('换会话后旧设置队列不得使用新Token提交，也不得覆盖新会话状态', async () => {
  const { pinia } = await import('@/pinia')
  const { useUserStore } = await import('./user')
  const user = useUserStore(pinia)
  let finish!: (value: Record<string, unknown>) => void
  const patch = vi.mocked(settingsApi.patchSettingsApi).mockImplementationOnce(() => (new Promise<Awaited<ReturnType<typeof settingsApi.patchSettingsApi>>['data']>((resolve) => {
    finish = resolve
  })).then(value => apiSuccess(value)))
  const first = updateSettings({ fontSize: 21 }).catch(error => error)
  const queued = updateSettings({ fontSize: 22 }).catch(error => error)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  user.setToken('rms_new')
  finish({})
  const { isCancel } = await import('axios')
  expect(isCancel(await first)).toBe(true)
  expect(isCancel(await queued)).toBe(true)
  expect(patch).toHaveBeenCalledTimes(1)
  expect(settingsSave.result).toBe('idle')
  user.setToken('')
})

describe('账户语言', () => {
  it('登录页的临时语言不写服务器，登录后以账户语言覆盖', async () => {
    chooseAnonymousLocale('zh-CN')
    expect(locale.value).toBe('zh-CN')
    expect(settingsApi.patchSettingsApi).not.toHaveBeenCalled()
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValueOnce(apiSuccess({ locale: 'en' }))
    await loadSettings()
    expect(locale.value).toBe('en')
    expect(settings.locale).toBe('en')
    expect(JSON.parse(localStorage.getItem('rawmark.settings')!).locale).toBe('en')
  })
  it('语言立即生效、串行保存并从服务器同步恢复，缺省恢复英文', async () => {
    const pending = updateSettings({ locale: 'zh-CN' })
    expect(locale.value).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    await pending
    expect(settingsApi.patchSettingsApi).toHaveBeenCalledWith({ locale: 'zh-CN' })
    vi.mocked(settingsApi.getSettingsApi).mockResolvedValueOnce(apiSuccess({ locale: 'zh-CN' }))
    await loadSettings()
    expect(locale.value).toBe('zh-CN')
    await loadSettings()
    expect(locale.value).toBe('en')
  })
  it('语言保存失败会报告错误并重新应用服务器语言', async () => {
    vi.mocked(settingsApi.patchSettingsApi).mockRejectedValueOnce(new ApiError(503, 'Cannot save language'))
    expect(await useSettingsChange()({ locale: 'zh-CN' })).toBe(false)
    expect(locale.value).toBe('en')
    expect(settings.locale).toBe('en')
    expect(toasts.some(item => item.text.includes('Cannot save language'))).toBe(true)
  })
  it('切换语言会更新已打开的设置分类与搜索，不翻译插件自带标题', async () => {
    ws.settings = 'appearance'
    await mount(SettingsDialog)
    expect(document.body.querySelector('.rm-settings-tab')!.textContent).toContain('Appearance')
    await updateSettings({ locale: 'zh-CN' })
    await nextTick()
    expect(document.body.querySelector('.rm-settings-tab')!.textContent).toContain('外观')
    expect(searchSettings('CSS 高级')).toEqual([expect.objectContaining({ id: 'css-snippets' })])
    cleanup.push(registerCommand({ id: 'plugin:i18n:sample', title: '插件原始标题', run() {} }))
    await updateSettings({ locale: 'en' })
    expect(allCommands().find(command => command.id === 'plugin:i18n:sample')?.title).toBe('插件原始标题')
    expect(allCommands().find(command => command.id === 'note.new')?.title).toBe('New note')
  })
})
