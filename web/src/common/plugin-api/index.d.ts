import type { Extension } from '@codemirror/state'
import type { MarkdownExtension } from '@lezer/markdown'

export type Cleanup = () => void
export type AsyncCleanup = () => void | Promise<void>
export type Awaitable<T> = T | Promise<T>
export type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue }

export interface PluginManifest {
  id: string
  name: string
  version: string
  apiVersion: 1
}

export interface HostModules {
  readonly '@codemirror/state': typeof import('@codemirror/state')
  readonly '@codemirror/view': typeof import('@codemirror/view')
  readonly '@codemirror/language': typeof import('@codemirror/language')
  readonly '@codemirror/commands': typeof import('@codemirror/commands')
  readonly '@lezer/common': typeof import('@lezer/common')
  readonly '@lezer/markdown': typeof import('@lezer/markdown')
  readonly '@lezer/highlight': typeof import('@lezer/highlight')
}

export interface PluginCommand {
  id: string
  title: string
  /** Retain declaration compatibility; do not bind by default. Users can add shortcuts in settings. */
  keys?: string[]
  when?: () => boolean
  run: () => Awaitable<void>
}

export interface MountContext {
  container: HTMLElement
  signal: AbortSignal
}

export interface PluginView {
  id: string
  title: string
  mount: (context: MountContext) => Awaitable<void | AsyncCleanup>
}

export type CodeBlockRenderer = (context: MountContext & {
  source: string
  language: string
  path: string
  colorMode: 'light' | 'dark'
}) => Awaitable<void | AsyncCleanup>

export interface VaultEvents {
  changed: { path: string, rev: string }
  moved: { from: string, path: string }
  deleted: { path: string }
  resync: undefined
}

export interface PluginVault {
  list: () => Promise<Array<{ path: string, dir: boolean, size: number, mtime: number }>>
  read: (path: string) => Promise<{ content: string, rev: string }>
  write: (path: string, content: string, options: { ifMatch: string } | { create: true }) => Promise<{ rev: string }>
  on: <K extends keyof VaultEvents>(event: K, callback: (value: VaultEvents[K]) => Awaitable<void>) => Cleanup
}

export interface PluginWorkspace {
  getActiveNote: () => { path: string, content: string, rev: string, dirty: boolean } | null
  openNote: (path: string) => Promise<void>
}

export interface PluginAPI {
  readonly manifest: Readonly<PluginManifest>
  readonly signal: AbortSignal
  readonly modules: HostModules
  addCommand: (command: PluginCommand) => Cleanup
  registerEditorExtension: (extension: Extension) => Cleanup
  registerMarkdownSyntax: (extension: MarkdownExtension) => Cleanup
  registerCodeBlockRenderer: (language: string, render: CodeBlockRenderer) => Cleanup
  addSidebarView: (view: PluginView) => Cleanup
  addSettingTab: (view: PluginView) => Cleanup
  registerCleanup: (cleanup: AsyncCleanup) => Cleanup
  readonly vault: PluginVault
  readonly workspace: PluginWorkspace
  readonly data: { load: () => Promise<JSONValue>, save: (value: JSONValue) => Promise<void> }
  notice: (message: string) => void
}

export default function activate(api: PluginAPI): Awaitable<void | AsyncCleanup>
