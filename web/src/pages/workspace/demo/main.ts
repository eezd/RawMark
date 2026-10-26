import { watchFontLoading } from '@@/appearance/font-loading'
// Unauthenticated editor demo for automated performance and interaction tests.
import { createEditorState, createEditorView } from '../editor'
import sample from './sample.md?raw'
import '@/i18n'
import '@@/appearance/base.css'

// ?repeat=N repeats the sample N times for large-document performance testing.
const repeat = Number(new URLSearchParams(location.search).get('repeat') ?? 1)
const doc = Array.from({ length: Math.max(1, repeat) }).fill(sample).join('\n')

watchFontLoading()
const view = createEditorView(document.getElementById('app')!, createEditorState({ doc }))
;(window as unknown as { rawmarkView: typeof view }).rawmarkView = view
