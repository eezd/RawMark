<script setup lang="ts">
import type { InlineStyles } from '@@/markdown/inline-styles'

import type { EditorSelection } from '@codemirror/state'
import type { FormatCommand } from '../editor/format'
import Icon from '@@/components/Icon/index.vue'
import InlineAppearance from '@@/components/InlineAppearance/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { insertLink } from '../editor/format'
import { applyInlineStyles, canFormatSelection, clearInlineStyles, selectionAppearance, toggleSelectionMark, toggleUnderline } from '../editor/inline-styles'
import { activeTab, editorView, onEditorUpdate, ws } from '../workspace'

const { settings } = useSettingsStore(pinia)

const root = ref<HTMLElement>()
const floating = ref<{ left: number, top: number, maxHeight: number, maxWidth: number } | null>(null)
const appearanceOpen = ref(false)
const baseSize = ref(settings.fontSize)
const appearance = ref<ReturnType<typeof selectionAppearance>>({ styles: {}, underline: false, bold: false, italic: false, strike: false, highlight: false, link: false })
let unsubscribe: (() => void) | undefined
let frame = 0
let dismissed: EditorSelection | undefined
const buttons = [
  { get title() {
    return translate('workspace.bold_5ceac6')
  }, label: 'B', cls: 'bold', key: 'bold', run: toggleSelectionMark('StrongEmphasis') },
  { get title() {
    return translate('workspace.italic_217901')
  }, label: 'I', cls: 'italic', key: 'italic', run: toggleSelectionMark('Emphasis') },
  { get title() {
    return translate('workspace.underline_d3b4a2')
  }, label: 'U', cls: 'underline', key: 'underline', run: toggleUnderline },
  { get title() {
    return translate('workspace.strikethrough_5b0508')
  }, label: 'S', cls: 'strike', key: 'strike', run: toggleSelectionMark('Strikethrough') },
  { get title() {
    return translate('workspace.highlight_05f954')
  }, label: 'M', cls: 'highlight', key: 'highlight', run: toggleSelectionMark('Highlight') },
] as const

function close(restoreFocus = false) {
  dismissed = editorView()?.state.selection
  floating.value = null
  appearanceOpen.value = false
  if (restoreFocus) editorView()?.focus()
}
function run(command: FormatCommand, keepPanel = false) {
  const view = editorView()
  if (!view || !canFormatSelection(view.state)) return
  command(view)
  if (!keepPanel) {
    appearanceOpen.value = false; view.focus()
  }
  sync()
}
function change(patch: InlineStyles) {
  run(applyInlineStyles(patch), true)
}

// Preserve the CM selection while allowing panel inputs to focus; avoid pointerdown.prevent, which loses clicks in WebKit.
function sync() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(async () => {
    const view = editorView()
    if (view && dismissed && !dismissed.eq(view.state.selection)) dismissed = undefined
    const inToolbar = !!root.value?.contains(document.activeElement)
    if (!view || !settings.selectionToolbar || !ws.active || activeTab()?.status !== 'ready' || ws.view !== 'notes' || ws.settings || ws.images !== null || (!view.hasFocus && !inToolbar) || !canFormatSelection(view.state) || dismissed?.eq(view.state.selection)) {
      floating.value = null
      appearanceOpen.value = false
      return
    }
    dismissed = undefined
    const coords = view.coordsAtPos(view.state.selection.main.head)
    const rect = view.scrollDOM.getBoundingClientRect()
    if (!coords || coords.bottom < rect.top || coords.top > rect.bottom) {
      floating.value = null; appearanceOpen.value = false; return
    }
    appearance.value = selectionAppearance(view.state)
    const position = view.domAtPos(view.state.selection.main.from).node
    const line = (position instanceof Element ? position : position.parentElement)!.closest('.cm-line')!
    baseSize.value = parseFloat(getComputedStyle(line).fontSize)
    const viewport = window.visualViewport
    const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0
    const width = viewport?.width ?? innerWidth; const height = viewport?.height ?? innerHeight
    floating.value ??= { left, top, maxHeight: height - 16, maxWidth: width - 16 }
    floating.value.maxHeight = Math.max(44, height - 16)
    floating.value.maxWidth = width - 16
    await nextTick()
    if (!root.value || !floating.value) return
    const box = root.value.getBoundingClientRect()
    const above = coords.top - box.height - 8
    floating.value = {
      left: Math.max(left + 8, Math.min(left + width - box.width - 8, coords.left - box.width / 2)),
      top: Math.max(top + 8, Math.min(top + height - box.height - 8, above >= Math.max(top, rect.top) ? above : coords.bottom + 8)),
      maxHeight: Math.max(44, height - 16),
      maxWidth: width - 16,
    }
  })
}
function outside(event: PointerEvent) {
  if (event.target instanceof Node && root.value?.contains(event.target)) return
  if (floating.value) close()
}
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && floating.value) {
    event.preventDefault(); event.stopPropagation(); close(true)
  }
}
onMounted(() => {
  unsubscribe = onEditorUpdate(sync)
  document.addEventListener('scroll', sync, true)
  document.addEventListener('selectionchange', sync)
  document.addEventListener('focusin', sync)
  document.addEventListener('focusout', sync)
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', sync)
  window.visualViewport?.addEventListener('resize', sync)
  window.visualViewport?.addEventListener('scroll', sync)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  cancelAnimationFrame(frame)
  document.removeEventListener('scroll', sync, true)
  document.removeEventListener('selectionchange', sync)
  document.removeEventListener('focusin', sync)
  document.removeEventListener('focusout', sync)
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', onKey, true)
  window.removeEventListener('resize', sync)
  window.visualViewport?.removeEventListener('resize', sync)
  window.visualViewport?.removeEventListener('scroll', sync)
})
watch(() => [ws.active, activeTab()?.status, settings.selectionToolbar, settings.uiFontSize, ws.settings, ws.images, ws.view], () => {
  dismissed = undefined; sync()
})
watch(appearanceOpen, sync)
watch(() => ws.active, () => {
  floating.value = null; appearanceOpen.value = false
})
</script>

<template>
  <Teleport to="body">
    <div v-if="floating" ref="root" class="rm-selection-popover" :style="{ left: `${floating.left}px`, top: `${floating.top}px`, maxHeight: `${floating.maxHeight}px`, maxWidth: `${floating.maxWidth}px` }">
      <div class="rm-selection-toolbar" role="toolbar" :aria-label="translate('workspace.format_selected_text_bd0a7d')">
        <button type="button" :title="translate('common.appearance_86a63f')" :aria-label="translate('common.appearance_86a63f')" :aria-expanded="appearanceOpen" aria-controls="rm-inline-appearance" @mousedown.prevent @click="appearanceOpen = !appearanceOpen">
          <Icon name="palette" />
        </button>
        <button v-for="button in buttons" :key="button.key" type="button" :title="button.title" :aria-label="button.title" :aria-pressed="appearance[button.key]" :class="button.cls" @mousedown.prevent @click="run(button.run)">
          {{ button.label }}
        </button>
        <button type="button" :title="translate('workspace.link_305378')" :aria-label="translate('workspace.link_305378')" :aria-pressed="appearance.link" @mousedown.prevent @click="run(insertLink)">
          <Icon name="link" />
        </button>
      </div>
      <InlineAppearance v-if="appearanceOpen" id="rm-inline-appearance" :styles="appearance.styles" :base-size="baseSize" @change="change" @clear="run(clearInlineStyles, true)" />
    </div>
  </Teleport>
</template>
