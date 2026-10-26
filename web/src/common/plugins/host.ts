import type { InstalledPlugin } from '@@/apis/plugins/type'
import type { AsyncCleanup, JSONValue, PluginAPI, PluginView, PluginWorkspace, VaultEvents } from '@@/plugin-api'
import { getPluginDataApi, getPluginsApi, savePluginDataApi } from '@@/apis/plugins'
import { getTreeApi } from '@@/apis/tree'
import { readNoteFile } from '@@/utils/note-files'
import { pluginResourceURL } from '@@/utils/resource-tickets'

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
  if (instance.stopped || !running) throw new Error('插件已停止，不能继续调用 SDK')
}

function cleanupFailure(instance: Instance, cause: unknown) {
  instance.cleanupErrors.push(cause)
  adapter.notice(`插件“${instance.info.name}”清理失败`)
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
  if (!finished) adapter.notice(`插件“${instance.info.name}”清理超过 5 秒`)
}

function fail(instance: Instance, phase: string, cause: unknown) {
  if (instance.stopped) return
  const message = `${phase}失败，已在当前页面停用；可在插件设置中重试`
  faults.set(instance.info.id, instance.info.revision)
  status(instance.info.id, 'error', message, cause)
  adapter.notice(`插件“${instance.info.name}”：${message}`)
  void stop(instance)
}

function localID(instance: Instance, id: string) {
  if (!/^[a-z0-9][\w.-]{0,63}$/i.test(id)) throw new Error('插件注册 id 无效')
  return `plugin:${instance.info.id}:${id}`
}

function addView(instance: Instance, map: typeof sidebarViews, view: PluginView) {
  assertActive(instance)
  if (!view.title.trim() || typeof view.mount !== 'function') throw new Error('插件视图必须提供标题与挂载函数')
  return track(instance, registerEntry(map, localID(instance, view.id), { ...view, owner: instance.info.id, fail: cause => fail(instance, '视图', cause) }))
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
      if (!command.title.trim() || typeof command.run !== 'function' || allCommands().some(c => c.id === commandID)) throw new Error('命令无效或重复注册')
      return track(instance, registerCommand({ ...command, id: commandID, keys: [], when: () => {
        if (instance.stopped) return false
        try {
          return command.when?.() ?? true
        } catch (cause) {
          fail(instance, '命令条件', cause); return false
        }
      }, run: () => {
        if (instance.stopped) return
        try {
          void Promise.resolve(command.run()).catch(cause => fail(instance, '命令', cause))
        } catch (cause) {
          fail(instance, '命令', cause)
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
      if (typeof render !== 'function') throw new Error('代码块渲染器必须为函数')
      return track(instance, registerCodeRenderer(language, { owner: id, render, fail: cause => fail(instance, '代码块渲染', cause) }))
    },
    addSidebarView: view => addView(instance, sidebarViews, view),
    addSettingTab: view => addView(instance, settingTabs, view),
    registerCleanup: (cleanup) => {
      if (typeof cleanup !== 'function') throw new Error('清理回调必须为函数')
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
        if (!['changed', 'moved', 'deleted', 'resync'].includes(event)) throw new Error('仓库事件类型无效')
        const listener = (e: Event) => {
          if (instance.stopped) return
          try {
            void Promise.resolve(callback(event === 'resync' ? undefined : (e as CustomEvent).detail)).catch(cause => fail(instance, '仓库事件', cause))
          } catch (cause) {
            fail(instance, '仓库事件', cause)
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
    onAbort = () => reject(new Error('插件已停止'))
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => reject(new Error('插件激活超过 10 秒')), 10_000)
  })
  const pending = (async () => {
    const sdk = await createAPI(instance)
    assertActive(instance)
    const { id, revision } = instance.info
    const url = await pluginResourceURL(id, revision)
    assertActive(instance)
    const module = await import(/* @vite-ignore */ url)
    assertActive(instance)
    if (typeof module.default !== 'function') throw new Error('插件必须默认导出激活函数')
    const cleanup: unknown = await module.default(sdk)
    if (cleanup !== undefined && typeof cleanup !== 'function') throw new Error('激活返回值必须为清理函数')
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
    fail(instance, '激活', cause)
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
  if (!running) return
  const currentSession = session
  const sequence = ++request
  try {
    const installed = (await getPluginsApi()).data.plugins
    if (!running || currentSession !== session || sequence !== request) return
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
    if (!running || currentSession !== session || sequence !== request) return
    pluginState.error = '读取插件列表失败，请检查连接后重试'
    pluginState.errorCause = cause
    adapter.notice(pluginState.error)
    for (const instance of instances.values()) {
      status(instance.info.id, 'paused')
      void stop(instance)
    }
  }
}

export function startPlugins(value: Adapter) {
  adapter = value
  running = true
  session++
  faults.clear()
  void refreshPlugins()
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
  void refreshPlugins()
}

export function pluginEditorFailure(error: unknown) {
  const owners = new Set([...editorExtensions.values(), ...markdownSyntax.values()].map(entry => entry.owner))
  if (!owners.size) throw error
  // CodeMirror 的事务/解析错误无法可靠定位任意第三方扩展；先保留文档并撤回外部扩展。
  queueMicrotask(() => {
    for (const owner of owners) {
      const instance = instances.get(owner)
      if (instance) fail(instance, '编辑器扩展', error)
    }
  })
}
