<script setup lang="ts">
import type { InlineStyles } from '../../markdown/inline-styles'

import { t as translate } from '@@/i18n/runtime'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { pinia } from '@/pinia'
import { useSettingsStore } from '@/pinia/stores/settings'
import { fixedThemeMode } from '../../appearance/appearance'
import { HOLLOW, INLINE_FONTS, SHADOW } from '../../markdown/inline-styles'

const props = defineProps<{ styles: InlineStyles, baseSize: number }>()

const emit = defineEmits<{ change: [patch: InlineStyles], clear: [] }>()

const { settings } = useSettingsStore(pinia)

const system = matchMedia('(prefers-color-scheme: dark)')
const systemDark = ref(system.matches)
function onSystem() {
  systemDark.value = system.matches
}
system.addEventListener('change', onSystem)
onBeforeUnmount(() => system.removeEventListener('change', onSystem))
const dark = computed(() => (fixedThemeMode(settings.theme) ?? (settings.colorMode === 'system' ? (systemDark.value ? 'dark' : 'light') : settings.colorMode)) === 'dark')
// SiYuan palette order; affect only selected text, not the theme background.
const foreground = computed(() => dark.value
  ? ['#f39993', '#ffd599', '#a6d5fa', '#b7dfb9', '#9aa0a6', '#3575f0', '#f3a92f', '#d23f31', '#f47c9c', '#4dd0e1', '#10df54', '#ecd424', '#1e1e1e']
  : ['#790600', '#8a4f00', '#005599', '#006b04', '#5f6368', '#3575f0', '#ff9200', '#d23f31', '#a40074', '#007080', '#006e2a', '#6b5a00', '#ffffff'])
const background = computed(() => dark.value
  ? ['#442724', '#554636', '#28405c', '#425347', '#3a3f42', '#031840', '#593905', '#3a0c09', '#4d1b40', '#1a5459', '#305415', '#4a4712', '#dadada']
  : ['#f5d1cf', '#ffe8c8', '#d6eaf9', '#d7eed8', '#e2e3e4', '#acd0fc', '#fddaab', '#ffb0a9', '#fdbfff', '#b1ffff', '#affad1', '#fff88f', '#222222'])
const relative = ref(false)
const size = ref(props.baseSize)
watch(() => props.styles['font-size'], (value) => {
  relative.value = value?.endsWith('em') ?? false
  size.value = value ? Math.round(parseFloat(value) * (relative.value ? 100 : 1)) : props.baseSize
}, { immediate: true })
function setSize() {
  if (!Number.isFinite(size.value) || size.value < (relative.value ? 56 : 9) || size.value > (relative.value ? 450 : 72)) return
  emit('change', { 'font-size': relative.value ? `${size.value / 100}em` : `${size.value}px` })
}
function switchSize() {
  size.value = Math.max(relative.value ? 56 : 9, Math.min(relative.value ? 450 : 72, Math.round(relative.value ? size.value / props.baseSize * 100 : size.value / 100 * props.baseSize)))
  setSize()
}
</script>

<template>
  <div class="rm-inline-appearance" role="region" :aria-label="translate('common.text_appearance_09f8f2')">
    <fieldset>
      <legend>{{ translate('common.color_scheme_2ae75e') }}</legend><div class="rm-inline-swatches">
        <button type="button" :title="translate('common.default_color_scheme_7f0813')" :aria-label="translate('common.default_color_scheme_7f0813')" @mousedown.prevent @click="emit('change', { 'color': undefined, 'background-color': undefined })">
          A
        </button>
        <button v-for="(color, index) in foreground" :key="index" type="button" :title="translate('common.color_scheme_d2f13c', { p0: index + 1 })" :aria-label="translate('common.color_scheme_d2f13c', { p0: index + 1 })" :style="{ color, backgroundColor: background[index] }" @mousedown.prevent @click="emit('change', { color, 'background-color': background[index] })">
          A
        </button>
      </div>
    </fieldset>
    <fieldset v-for="group in [{ key: 'color', get title() { return translate('common.text_color_fcaea5') }, colors: foreground }, { key: 'background-color', get title() { return translate('common.background_color_6d2b29') }, colors: background }]" :key="group.key">
      <legend>{{ group.title }}</legend><div class="rm-inline-swatches">
        <button type="button" :title="translate('common.default_4a2e3e', { p0: group.title })" :aria-label="translate('common.default_4a2e3e', { p0: group.title })" @mousedown.prevent @click="emit('change', { [group.key]: undefined })">
          ↺
        </button>
        <button v-for="(color, index) in group.colors" :key="color" type="button" :title="`${group.title} ${index + 1}`" :aria-label="`${group.title} ${index + 1}`" :aria-pressed="styles[group.key as keyof InlineStyles] === color" :style="group.key === 'color' ? { color } : { backgroundColor: color, color: foreground[index] }" @mousedown.prevent @click="emit('change', { [group.key]: color })">
          A
        </button>
        <label class="rm-inline-custom" :title="translate('common.custom_fc732e', { p0: group.title })"><span>{{ translate('common.custom_4eafa9') }}</span><input type="color" :aria-label="translate('common.custom_fc732e', { p0: group.title })" :value="styles[group.key as keyof InlineStyles] ?? (group.key === 'color' ? '#333333' : '#fff88f')" @change="emit('change', { [group.key]: ($event.target as HTMLInputElement).value })"></label>
      </div>
    </fieldset>
    <fieldset>
      <legend>{{ translate('common.text_effects_b8be49') }}</legend><div class="rm-inline-effects">
        <button type="button" :title="translate('common.outline_837aa5')" :aria-label="translate('common.outline_837aa5')" :aria-pressed="!!styles['-webkit-text-stroke']" :style="{ WebkitTextStroke: HOLLOW, WebkitTextFillColor: 'transparent' }" @mousedown.prevent @click="emit('change', { '-webkit-text-stroke': styles['-webkit-text-stroke'] ? undefined : HOLLOW, '-webkit-text-fill-color': styles['-webkit-text-stroke'] ? undefined : 'transparent' })">
          A
        </button>
        <button type="button" :title="translate('common.shadow_caabf3')" :aria-label="translate('common.shadow_caabf3')" :aria-pressed="!!styles['text-shadow']" :style="{ textShadow: SHADOW }" @mousedown.prevent @click="emit('change', { 'text-shadow': styles['text-shadow'] ? undefined : SHADOW })">
          A
        </button>
      </div>
    </fieldset>
    <label class="rm-inline-control">{{ translate('common.font_078838') }}<select :aria-label="translate('common.selection_font_3ff21e')" :value="styles['font-family'] ?? ''" @change="emit('change', { 'font-family': ($event.target as HTMLSelectElement).value || undefined })"><option value="">{{ translate('common.inherit_body_font_20476e') }}</option><option v-for="font in INLINE_FONTS" :key="font.css" :value="font.css">{{ font.label }}</option></select></label>
    <div class="rm-inline-control">
      <span>{{ translate('common.font_size_f71561') }}</span><label><input v-model="relative" type="checkbox" :aria-label="translate('common.relative_font_size_45afe1')" @change="switchSize"> {{ translate('common.relative_font_size_45afe1') }}</label><el-button native-type="button" class="rm-btn" @mousedown.prevent @click="emit('change', { 'font-size': undefined })">
        {{ translate('common.default_844b8c') }}
      </el-button>
    </div>
    <form class="rm-inline-size" @submit.prevent="setSize">
      <input v-model.number="size" type="range" :min="relative ? 56 : 9" :max="relative ? 450 : 72" step="1" :aria-label="translate('common.selection_font_size_slider_494d79')" @change="setSize"><input v-model.number="size" type="number" :min="relative ? 56 : 9" :max="relative ? 450 : 72" step="1" :aria-label="translate('common.selection_font_size_5a5162')" @change="setSize"><span>{{ relative ? '%' : 'px' }}</span>
    </form>
    <el-button native-type="button" class="rm-btn rm-inline-clear" @mousedown.prevent @click="emit('clear')">
      {{ translate('common.clear_appearance_384fbf') }}
    </el-button>
  </div>
</template>
