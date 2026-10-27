import { watchFontLoading } from '@@/appearance/font-loading'
import { t } from '@@/i18n/runtime'
// Unauthenticated editor demo for automated performance and interaction tests.
import { createEditorState, createEditorView } from '../editor'
import sample from './sample.md?raw'
import '@/i18n'
import '@@/appearance/base.css'
import './demo.css'

// ?repeat=N repeats the sample N times for large-document performance testing.
const repeat = Number(new URLSearchParams(location.search).get('repeat') ?? 1)
const doc = Array.from({ length: Math.max(1, repeat) }).fill(sample).join('\n')

watchFontLoading()
const header = document.createElement('header')
const title = document.createElement('strong')
title.textContent = `RawMark ${__RAWMARK_RELEASE__}`
const notice = document.createElement('span')
notice.textContent = t('common.demo_notice')
const github = document.createElement('a')
github.href = 'https://github.com/eezd/RawMark'
github.textContent = 'GitHub'
header.append(title, notice, github)
document.body.prepend(header)
const view = createEditorView(document.getElementById('app')!, createEditorState({ doc }))
;(window as unknown as { rawmarkView: typeof view }).rawmarkView = view
