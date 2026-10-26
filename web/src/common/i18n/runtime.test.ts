// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { applyLocale, DEFAULT_LOCALE, locale, t } from './runtime'

const catalogs = import.meta.glob<Record<string, string>>(['./*.json', '../../pages/*/locales/*.json'], { eager: true, import: 'default' })
afterEach(() => applyLocale(DEFAULT_LOCALE))

it('默认英文，语言切换同时更新 HTML 语言与带参数提示', () => {
  expect(DEFAULT_LOCALE).toBe('en')
  applyLocale('en')
  expect(document.documentElement.lang).toBe('en')
  expect(t('common.retry_b8784c')).toBe('Retry')
  expect(t('workspace.heading_a4f510', { p0: 2 })).toBe('Heading 2')
  expect(t('workspace.notes_fd9460', { count: 1 })).toBe('1 note')
  expect(t('workspace.notes_fd9460', { count: 2 })).toBe('2 notes')
  expect(t('settings.permanently_deleted_with_failures', { count: 1, failed: 2 })).toBe('Permanently deleted 1 item; 2 failed')
  applyLocale('zh-CN')
  expect(locale.value).toBe('zh-CN')
  expect(document.documentElement.lang).toBe('zh-CN')
  expect(t('common.retry_b8784c')).toBe('重试')
  expect(t('workspace.heading_a4f510', { p0: 2 })).toBe('设置 2 级标题')
  expect(t('settings.permanently_deleted_with_failures', { count: 1, failed: 2 })).toBe('已永久删除 1 项，2 项失败')
})

it('每个模块的英文与中文消息键和插值参数一致', () => {
  for (const [path, en] of Object.entries(catalogs).filter(([path]) => path.endsWith('/en.json'))) {
    const zh = catalogs[path.replace('/en.json', '/zh-CN.json')]!
    expect(Object.keys(en).sort(), path).toEqual(Object.keys(zh).sort())
    for (const [key, value] of Object.entries(en)) {
      expect(zh[key], `${path}: ${key}`).toBeTruthy()
      expect([...new Set([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort(), key)
        .toEqual([...new Set([...zh[key]!.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort())
    }
  }
})

it('源码中使用的消息键均存在，默认英文不遗留中文界面文案', () => {
  const sources = import.meta.glob<string>(['../../**/*.ts', '../../**/*.vue', '!../../**/*.test.ts'], { eager: true, query: '?raw', import: 'default' })
  for (const [path, source] of Object.entries(sources)) {
    for (const [, key] of source.matchAll(/(?:translate|\bt)\('((?:common|workspace|settings|login|error)\.[^']+)'/g)) {
      const [module, id] = key!.split('.')
      const catalogPath = module === 'common' ? './en.json' : `../../pages/${module}/locales/en.json`
      expect(catalogs[catalogPath]?.[id!], `${path}: ${key}`).toBeTruthy()
    }
  }
  for (const [path, catalog] of Object.entries(catalogs).filter(([path]) => path.endsWith('/en.json'))) {
    expect(/[\u3400-\u9FFF]/.test(JSON.stringify(catalog)), path).toBe(false)
  }
})
