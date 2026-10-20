import * as state from '@codemirror/state'
import * as view from '@codemirror/view'
import * as language from '@codemirror/language'
import * as commands from '@codemirror/commands'
import * as common from '@lezer/common'
import * as markdown from '@lezer/markdown'
import * as highlight from '@lezer/highlight'
import type { HostModules } from '../plugin-api'

export const modules: HostModules = Object.freeze({
  '@codemirror/state': state,
  '@codemirror/view': view,
  '@codemirror/language': language,
  '@codemirror/commands': commands,
  '@lezer/common': common,
  '@lezer/markdown': markdown,
  '@lezer/highlight': highlight,
})
