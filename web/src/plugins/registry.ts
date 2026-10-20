import { Facet, StateEffect, type Extension } from '@codemirror/state'
import type { MarkdownExtension } from '@lezer/markdown'
import { shallowReactive } from 'vue'
import type { CodeBlockRenderer, PluginView } from '../plugin-api'
import { renderMermaid } from '../markdown/render'

export const pluginsPaused = typeof location !== 'undefined' && new URLSearchParams(location.search).has('disable-plugins')
export const pluginRefresh = StateEffect.define<null>()
export const notePath = Facet.define<{ path: string }, { path: string }>({ combine: (values) => values[0] ?? { path: '' } })
export const editorExtensions = new Map<symbol, { owner: string; value: Extension }>()
export const markdownSyntax = new Map<symbol, { owner: string; value: MarkdownExtension }>()
export interface OwnedView extends PluginView { owner: string; fail: (error: unknown) => void }
export interface OwnedRenderer { owner: string; render: CodeBlockRenderer; fail: (error: unknown) => void }
export const codeRenderers = new Map<string, OwnedRenderer>()
export const sidebarViews = shallowReactive(new Map<string, OwnedView>())
export const settingTabs = shallowReactive(new Map<string, OwnedView>())
export const pluginEvents = new EventTarget()
let reconfigure: () => void = () => {}
let editorFailure: (error: unknown) => void = (error) => { throw error }

export function setPluginEditorHandlers(change: () => void, failure: (error: unknown) => void) {
  reconfigure = change
  editorFailure = failure
}
export function reportEditorFailure(error: unknown) { editorFailure(error) }
export function pluginsChanged() { reconfigure() }

export function registerEntry<K, V>(map: Map<K, V>, key: K, value: V): () => void {
  if (map.has(key)) throw new Error('插件重复注册，不能覆盖已有功能')
  map.set(key, value)
  try { pluginsChanged() } catch (error) { map.delete(key); pluginsChanged(); throw error }
  return () => {
    if (map.get(key) !== value) return
    map.delete(key)
    pluginsChanged()
  }
}

export function registerCodeRenderer(language: string, value: OwnedRenderer) {
  const key = language.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_+-]*$/.test(key)) throw new Error('代码块语言名无效')
  return registerEntry(codeRenderers, key, value)
}

registerCodeRenderer('mermaid', {
  owner: 'rawmark-mermaid',
  async render({ source, container, signal }) {
    if (!source.trim()) { container.textContent = '空图表'; return }
    try {
      const svg = await renderMermaid(source)
      if (!signal.aborted) container.innerHTML = svg
    } catch (error) {
      if (signal.aborted) return
      container.className = 'cm-rm-render-error'
      container.textContent = error instanceof Error ? error.message : '图表语法错误'
    }
  },
  fail: () => window.dispatchEvent(new CustomEvent('rawmark-plugin-notice', { detail: '内置图表渲染失败，请重试' })),
})
