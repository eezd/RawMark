// @vitest-environment happy-dom
import { applyLocale } from '@@/i18n/runtime'
import { shallowMount } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import OutlinePanel from './components/OutlinePanel.vue'
import { createEditorState, createEditorView } from './editor'
import * as workspace from './workspace'

it('切换语言仅翻译空标题占位，保留真实标题与正文', async () => {
  applyLocale('en')
  const doc = '# \n\n## 用户标题 User heading\n'
  const host = document.createElement('div')
  document.body.append(host)
  const view = createEditorView(host, createEditorState({ doc }))
  vi.spyOn(workspace, 'editorView').mockReturnValue(view)
  vi.spyOn(workspace, 'activeTab').mockReturnValue({ path: 'note.md', rev: 'r1', status: 'ready', dirty: false })
  const wrapper = shallowMount(OutlinePanel)
  try {
    await vi.waitFor(() => expect(wrapper.findAll('li').map(item => item.text())).toEqual(['(Untitled)', '用户标题 User heading']))
    for (const [language, label] of [['zh-CN', '（无标题）'], ['en', '(Untitled)']] as const) {
      applyLocale(language)
      await nextTick()
      expect(wrapper.findAll('li').map(item => item.text())).toEqual([label, '用户标题 User heading'])
      expect(view.state.doc.toString()).toBe(doc)
    }
  } finally {
    wrapper.unmount()
    view.destroy()
    host.remove()
    vi.restoreAllMocks()
    applyLocale('en')
  }
})
