import type { CodeBlockRenderer, PluginView } from '@@/plugin-api'
import type { Extension } from '@codemirror/state'
import type { MarkdownExtension } from '@lezer/markdown'
import { t as translate } from '@@/i18n/runtime'
import { Facet, StateEffect } from '@codemirror/state'
import { shallowReactive } from 'vue'
import { renderMermaid } from '../markdown/render'

export const pluginsPaused = typeof location !== 'undefined' && new URLSearchParams(location.search).has('disable-plugins')
export const pluginRefresh = StateEffect.define<null>()
export const notePath = Facet.define<{ path: string }, { path: string }>({ combine: values => values[0] ?? { path: '' } })
export const editorExtensions = new Map<symbol, { owner: string, value: Extension }>()
export const markdownSyntax = new Map<symbol, { owner: string, value: MarkdownExtension }>()
export interface OwnedView extends PluginView { owner: string, fail: (error: unknown) => void }
export interface OwnedRenderer { owner: string, render: CodeBlockRenderer, fail: (error: unknown) => void }
export const codeRenderers = new Map<string, OwnedRenderer>()
export const sidebarViews = shallowReactive(new Map<string, OwnedView>())
export const settingTabs = shallowReactive(new Map<string, OwnedView>())
export const pluginEvents = new EventTarget()
let reconfigure: () => void = () => {}
let editorFailure: (error: unknown) => void = (error) => {
  throw error
}

export function setPluginEditorHandlers(change: () => void, failure: (error: unknown) => void) {
  reconfigure = change
  editorFailure = failure
}
export function reportEditorFailure(error: unknown) {
  editorFailure(error)
}
export function pluginsChanged() {
  reconfigure()
}

export function registerEntry<K, V>(map: Map<K, V>, key: K, value: V): () => void {
  if (map.has(key)) throw new Error(translate('common.duplicate_plugin_registration_cannot_replace_fbc39b'))
  map.set(key, value)
  try {
    pluginsChanged()
  } catch (error) {
    map.delete(key); pluginsChanged(); throw error
  }
  return () => {
    if (map.get(key) !== value) return
    map.delete(key)
    pluginsChanged()
  }
}

export function registerCodeRenderer(language: string, value: OwnedRenderer) {
  const key = language.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_+-]*$/.test(key)) throw new Error(translate('common.invalid_code_block_language_name_8de01a'))
  return registerEntry(codeRenderers, key, value)
}

registerCodeRenderer('mermaid', {
  owner: 'rawmark-mermaid',
  async render({ source, container, signal }) {
    if (!source.trim()) {
      container.textContent = translate('common.empty_diagram_37edb7'); return
    }
    try {
      const svg = await renderMermaid(source)
      if (!signal.aborted) container.innerHTML = svg
    } catch (error) {
      if (signal.aborted) return
      container.className = 'cm-rm-render-error'
      container.textContent = error instanceof Error ? error.message : translate('common.invalid_diagram_syntax_333e74')
    }
  },
  fail: () => window.dispatchEvent(new CustomEvent('rawmark-plugin-notice', { get detail() {
    return translate('common.built_in_diagram_rendering_failed_e93cc6')
  } })),
})
