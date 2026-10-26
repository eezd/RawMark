<script setup lang="ts">
import FontPicker from '@@/components/FontPicker/index.vue'
import { ref, watch } from 'vue'
import { CONTENT_WIDTHS, DEFAULTS, TAB_SIZES, useSettingsStore } from '@/pinia/stores/settings'
import { useSettingsChange } from '../composables/use-settings-change'
import SettingRow from './SettingRow.vue'

const { settings } = useSettingsStore()
const change = useSettingsChange()
const fontInput = ref(String(settings.fontSize))
watch(() => settings.fontSize, (value) => {
  fontInput.value = String(value)
})
function changeFont(value: string) {
  fontInput.value = value
  if (!value.trim()) return
  const size = Number(value)
  if (Number.isFinite(size) && size > 0 && size !== settings.fontSize) void change({ fontSize: size })
}
</script>

<template>
  <h3 class="rm-settings-group-title">
    正文与代码
  </h3>
  <SettingRow id="text-font" control="rm-text-font" resettable @reset="change({ textFont: DEFAULTS.textFont })">
    <FontPicker id="rm-text-font" setting="textFont" />
  </SettingRow>
  <SettingRow id="code-font" control="rm-code-font" resettable @reset="change({ codeFont: DEFAULTS.codeFont })">
    <FontPicker id="rm-code-font" setting="codeFont" />
  </SettingRow>
  <SettingRow id="font-size" control="rm-font-size" resettable @reset="change({ fontSize: DEFAULTS.fontSize })">
    <el-input id="rm-font-size" type="number" :model-value="fontInput" @input="changeFont" @blur="fontInput = String(settings.fontSize)">
      <template #append>
        px
      </template>
    </el-input>
  </SettingRow>
  <SettingRow id="content-width" resettable @reset="change({ contentWidth: DEFAULTS.contentWidth })">
    <el-segmented :model-value="settings.contentWidth" :options="CONTENT_WIDTHS" aria-label="正文宽度" @change="change({ contentWidth: Number($event) })" />
  </SettingRow>
  <SettingRow id="line-height" control="rm-line-height" resettable @reset="change({ lineHeight: DEFAULTS.lineHeight })">
    <el-slider id="rm-line-height" :min="1.2" :max="2.5" :step="0.05" :model-value="settings.lineHeight" @change="change({ lineHeight: Number($event) })" /><output for="rm-line-height">{{ settings.lineHeight.toFixed(2) }}</output>
  </SettingRow>
  <details id="rm-setting-typography-preview" class="rm-settings-details" tabindex="-1">
    <summary>排版预览</summary><article class="rm-typography-preview">
      <h2>让文字自由呼吸</h2><p>用简洁的记录，连接每一个想法。Markdown 文件始终属于你。</p><p>真实内容，自然排版，专注当下的灵感。</p><code>const idea = 'Hello, RawMark'</code>
    </article>
  </details>
  <h3 class="rm-settings-group-title">
    编辑行为
  </h3>
  <SettingRow id="selection-toolbar" control="rm-selection-toolbar">
    <el-switch id="rm-selection-toolbar" :model-value="settings.selectionToolbar" @change="change({ selectionToolbar: Boolean($event) })" />
  </SettingRow>
  <SettingRow id="spellcheck" control="rm-spellcheck">
    <el-switch id="rm-spellcheck" :model-value="settings.spellcheck" @change="change({ spellcheck: Boolean($event) })" />
  </SettingRow>
  <SettingRow id="tab-size" control="rm-tab-size" resettable @reset="change({ tabSize: DEFAULTS.tabSize })">
    <el-select id="rm-tab-size" :model-value="settings.tabSize" @change="change({ tabSize: $event })">
      <el-option v-for="n in TAB_SIZES" :key="n" :value="n" :label="`${n} 列`" />
    </el-select>
  </SettingRow>
</template>

<style scoped lang="scss">
:deep(.el-input) {
  width: 130px;
}
:deep(.el-slider) {
  width: 150px;
  margin: 0 10px;
}
:deep(.el-segmented) {
  max-width: 100%;
}
</style>
