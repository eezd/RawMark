import type { InstalledPlugin } from '@@/apis/plugins/type'
import type { AsyncCleanup, JSONValue, PluginAPI, PluginView, PluginWorkspace, VaultEvents } from '@@/plugin-api'
import { getPluginDataApi, getPluginsApi, savePluginDataApi } from '@@/apis/plugins'
import { getTreeApi } from '@@/apis/tree'
import { t as translate } from '@@/i18n/runtime'
import { readNoteFile } from '@@/utils/note-files'
import { pluginResourceURL } from '@@/utils/resource-tickets'

import { CanceledError, isCancel } from 'axios'
import { reactive } from 'vue'
import { allCommands, registerCommand } from '../utils/commands'
import { editorExtensions, markdownSyntax, pluginEvents, pluginsPaused, registerCodeRenderer, registerEntry, settingTabs, sidebarViews } from './registry'

export const pluginState = reactive({ installed: [] as InstalledPlugin[], status: {} as Record<string, { phase: string, error: string, cause?: unknown, cleanupErrors?: unknown[] }>, error: '', errorCause: undefined as unknown })
interface Adapter extends PluginWorkspace {
  notice: (message: string) => void
  writeNote: PluginAPI['vault']['write']
}
interface Instance {
  info: InstalledPlugin
  controller: AbortController
  stopped: boolean
  cleanups: Set<() => void>
  pending: Promise<unknown>[]
  cleanupErrors: unknown[]
}
const instances = new Map<string, Instance>()
const faults = new Map<string, string>()
let adapter: Adapter
let running = false
let session = 0
let request = 0
let loading = false

function status(id: string, phase: string, error = '', cause?: unknown) {
  pluginState.status[id] = { phase, error, cause, cleanupErrors: pluginState.status[id]?.cleanupErrors }
}
function assertActive(instance: Instance) {
  if (instance.stopped || !running) throw new Error(translate('common.this_plugin_has_stopped_and_796b24'))
}

function cleanupFailure(instance: Instance, cause: unknown) {
  instance.cleanupErrors.push(cause)
  adapter.notice(translate('common.plugin_cleanup_failed_6388d7', { p0: instance.info.name }))
}

function track(instance: Instance, cleanup: AsyncCleanup): () => void {
  assertActive(instance)
  let done = false
  const remove = () => {
    if (done) return
    done = true
    instance.cleanups.delete(remove)
    try {
      const pending = Promise.resolve(cleanup()).catch(cause => cleanupFailure(instance, cause))
      instance.pending.push(pending)
    } catch (cause) {
      cleanupFailure(instance, cause)
    }
  }
  instance.cleanups.add(remove)
  return remove
}

async function stop(instance: Instance) {
  if (instance.stopped) return
  instance.stopped = true
  instance.controller.abort()
  instances.delete(instance.info.id)
  for (const remove of [...instance.cleanups].reverse()) remove()
  let timer: ReturnType<typeof setTimeout>
  const finished = await Promise.race([
    Promise.all(instance.pending).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(resolve, 5000, false)
    }),
  ])
  clearTimeout(timer!)
  if (!finished) adapter.notice(translate('common.plugin_cleanup_exceeded_seconds_32945c', { p0: instance.info.name }))
}

function fail(instance: Instance, phase: string, cause: unknown) {
  if (instance.stopped) return
  const message = translate('common.failed_and_has_been_disabled_aa6412', { p0: phase })
  faults.set(instance.info.id, instance.info.revision)
  status(instance.info.id, 'error', message, cause)
  adapter.notice(translate('common.plugin_44a1b7', { p0: instance.info.name, p1: message }))
  void stop(instance)
}

function localID(instance: Instance, id: string) {
  if (!/^[a-z0-9][\w.-]{0,63}$/i.test(id)) throw new Error(translate('common.invalid_plugin_registration_id_9702fe'))
  return `plugin:${instance.info.id}:${id}`
}

function addView(instance: Instance, map: typeof sidebarViews, view: PluginView) {
  assertActive(instance)
  if (!view.title.trim() || typeof view.mount !== 'function') throw new Error(translate('common.plugin_views_require_a_title_79ae1b'))
  return track(instance, registerEntry(map, localID(instance, view.id), { ...view, owner: instance.info.id, fail: cause => fail(instance, translate('common.view_1c5c06'), cause) }))
}

async function createAPI(instance: Instance): Promise<PluginAPI> {
  const { modules } = await import('./modules')
  const { id, name, version, apiVersion } = instance.info
  const check = () => assertActive(instance)
  return Object.freeze({
    manifest: Object.freeze({ id, name, version, apiVersion }),
    signal: instance.controller.signal,
    modules,
    addCommand(command) {
      check()
      const commandID = localID(instance, command.id)
      if (!command.title.trim() || typeof command.run !== 'function' || allCommands().some(c => c.id === commandID)) throw new Error(translate('common.invalid_or_duplicate_command_f6503b'))
      return track(instance, registerCommand({ ...command, id: commandID, keys: [], when: () => {
        if (instance.stopped) return false
        try {
          return command.when?.() ?? true
        } catch (cause) {
          fail(instance, translate('common.command_condition_df314d'), cause); return false
        }
      }, run: () => {
        if (instance.stopped) return
        try {
          void Promise.resolve(command.run()).catch(cause => fail(instance, translate('common.command_928f87'), cause))
        } catch (cause) {
          fail(instance, translate('common.command_928f87'), cause)
        }
      } }))
    },
    registerEditorExtension(extension) {
      check()
      return track(instance, registerEntry(editorExtensions, Symbol(id), { owner: id, value: extension }))
    },
    registerMarkdownSyntax(extension) {
      check()
      return track(instance, registerEntry(markdownSyntax, Symbol(id), { owner: id, value: extension }))
    },
    registerCodeBlockRenderer(language, render) {
      check()
      if (typeof render !== 'function') throw new Error(translate('common.a_code_block_renderer_must_952f83'))
      return track(instance, registerCodeRenderer(language, { owner: id, render, fail: cause => fail(instance, translate('common.code_block_rendering_1d4ae4'), cause) }))
    },
    addSidebarView: view => addView(instance, sidebarViews, view),
    addSettingTab: view => addView(instance, settingTabs, view),
    registerCleanup: (cleanup) => {
      if (typeof cleanup !== 'function') throw new Error(translate('common.a_cleanup_callback_must_be_6ce04e'))
      return track(instance, cleanup)
    },
    vault: {
      list: () => {
        check(); return getTreeApi().then(({ data }) => data.entries)
      },
      read: (path) => {
        check(); return readNoteFile(path)
      },
      write: (path, content, options) => {
        check(); return adapter.writeNote(path, content, options)
      },
      on<K extends keyof VaultEvents>(event: K, callback: (value: VaultEvents[K]) => void | Promise<void>) {
        check()
        if (!['changed', 'moved', 'deleted', 'resync'].includes(event)) throw new Error(translate('common.invalid_vault_event_type_8621e4'))
        const listener = (e: Event) => {
          if (instance.stopped) return
          try {
            void Promise.resolve(callback(event === 'resync' ? undefined : (e as CustomEvent).detail)).catch(cause => fail(instance, translate('common.vault_event_03582e'), cause))
          } catch (cause) {
            fail(instance, translate('common.vault_event_03582e'), cause)
          }
        }
        pluginEvents.addEventListener(event, listener)
        return track(instance, () => pluginEvents.removeEventListener(event, listener))
      },
    },
    workspace: {
      getActiveNote: () => {
        check(); return adapter.getActiveNote()
      },
      openNote: (path) => {
        check(); return adapter.openNote(path)
      },
    },
    data: {
      load: async () => {
        check(); return ((await getPluginDataApi(id)).data).data as JSONValue
      },
      save: async (data) => {
        check(); await savePluginDataApi({ id, data })
      },
    },
    notice: (message) => {
      check(); adapter.notice(String(message))
    },
  } satisfies PluginAPI)
}

async function activate(instance: Instance) {
  let timer: ReturnType<typeof setTimeout>
  const signal = instance.controller.signal
  let onAbort: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error(translate('common.plugin_stopped_9ac692')))
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => reject(new Error(translate('common.plugin_activation_exceeded_seconds_cffeae'))), 10_000)
  })
  const pending = (async () => {
    const sdk = await createAPI(instance)
    assertActive(instance)
    const { id, revision } = instance.info
    const url = await pluginResourceURL(id, revision)
    assertActive(instance)
    const module = await import(/* @vite-ignore */ url)
    assertActive(instance)
    if (typeof module.default !== 'function') throw new Error(translate('common.a_plugin_must_export_an_1fbc50'))
    const cleanup: unknown = await module.default(sdk)
    if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error(translate('common.activation_must_return_a_cleanup_ea3a8c'))
    if (cleanup) {
      if (instance.stopped) {
        try {
          await cleanup()
        } catch (cause) {
          cleanupFailure(instance, cause)
        }
      } else {
        track(instance, cleanup as AsyncCleanup)
      }
    }
  })()
  try {
    await Promise.race([pending, interrupted])
    if (!instance.stopped) status(instance.info.id, 'active')
  } catch (cause) {
    fail(instance, translate('common.activation_dd1286'), cause)
  } finally {
    clearTimeout(timer!)
    signal.removeEventListener('abort', onAbort)
  }
}

async function pump() {
  if (loading || !running || pluginsPaused || pluginState.error) return
  loading = true
  const currentSession = session
  try {
    // eslint-disable-next-line no-unmodified-loop-condition -- await 期间可由停用或刷新变更会话。
    while (running && currentSession === session && !pluginState.error) {
      const next = pluginState.installed.find(p => p.enabled && !instances.has(p.id) && faults.get(p.id) !== p.revision)
      if (!next) break
      const instance: Instance = { info: { ...next }, controller: new AbortController(), stopped: false, cleanups: new Set(), pending: [], cleanupErrors: [] }
      instances.set(next.id, instance)
      status(next.id, 'loading')
      pluginState.status[next.id]!.cleanupErrors = instance.cleanupErrors
      await activate(instance)
    }
  } finally {
    loading = false; if (running && currentSession !== session) void pump()
  }
}

export async function refreshPlugins() {
  if (!running) throw new CanceledError(translate('common.plugin_host_stopped_901067'))
  const currentSession = session
  const sequence = ++request
  try {
    const installed = (await getPluginsApi()).data.plugins
    if (!running || currentSession !== session || sequence !== request) throw new CanceledError(translate('common.plugin_refresh_superseded_2fa245'))
    pluginState.installed = installed
    pluginState.error = ''
    pluginState.errorCause = undefined
    for (const instance of instances.values()) {
      if (!installed.some(p => p.id === instance.info.id && p.revision === instance.info.revision && p.enabled)) void stop(instance)
    }
    for (const p of installed) {
      if (!p.enabled) {
        faults.delete(p.id); status(p.id, 'disabled')
      } else if (pluginsPaused) {
        status(p.id, 'paused')
      }
    }
    void pump()
  } catch (cause) {
    if (!running || currentSession !== session || sequence !== request) throw new CanceledError(translate('common.plugin_refresh_superseded_2fa245'))
    if (isCancel(cause)) throw cause
    pluginState.error = translate('common.could_not_load_plugins_a1c343', { p0: cause instanceof Error ? cause.message : String(cause) })
    pluginState.errorCause = cause
    for (const instance of instances.values()) {
      status(instance.info.id, 'paused')
      void stop(instance)
    }
    throw cause
  }
}

export function startPlugins(value: Adapter) {
  adapter = value
  running = true
  const currentSession = ++session
  faults.clear()
  void refreshPlugins().catch((cause) => {
    if (running && currentSession === session && !isCancel(cause)) value.notice(pluginState.error)
  })
}

export function stopPlugins() {
  running = false
  session++
  for (const instance of instances.values()) void stop(instance)
  pluginState.installed = []
  pluginState.status = {}
}

export function retryPlugin(id: string) {
  faults.delete(id)
  return refreshPlugins()
}

export function pluginEditorFailure(error: unknown) {
  const owners = new Set([...editorExtensions.values(), ...markdownSyntax.values()].map(entry => entry.owner))
  if (!owners.size) throw error
  // CodeMirror 的事务/解析错误无法可靠定位任意第三方扩展；先保留文档并撤回外部扩展。
  queueMicrotask(() => {
    for (const owner of owners) {
      const instance = instances.get(owner)
      if (instance) fail(instance, translate('common.editor_extension_28bb35'), error)
    }
  })
}
