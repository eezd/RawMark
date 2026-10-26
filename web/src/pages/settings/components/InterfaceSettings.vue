<script setup lang="ts">
import { UI_FONT_SIZE } from '@@/appearance/typography'
import FontPicker from '@@/components/FontPicker/index.vue'
import LocaleSelect from '@@/components/LocaleSelect/index.vue'
import { DEFAULTS, useSettingsStore } from '@/pinia/stores/settings'
import { useSettingsChange } from '../composables/use-settings-change'
import AppearanceSettings from './AppearanceSettings.vue'
import SettingRow from './SettingRow.vue'

const { settings } = useSettingsStore()
const change = useSettingsChange()
</script>

<template>
  <SettingRow id="locale" control="rm-locale">
    <LocaleSelect id="rm-locale" @change="change({ locale: $event })" />
  </SettingRow>
  <SettingRow id="ui-font" control="rm-ui-font" resettable @reset="change({ uiFont: DEFAULTS.uiFont })">
    <FontPicker id="rm-ui-font" setting="uiFont" />
  </SettingRow>
  <SettingRow id="ui-font-size" control="rm-ui-font-size" resettable @reset="change({ uiFontSize: DEFAULTS.uiFontSize })">
    <el-input-number id="rm-ui-font-size" :min="UI_FONT_SIZE.min" :max="UI_FONT_SIZE.max" :step="1" :model-value="settings.uiFontSize" @change="($event !== undefined && $event !== null) && change({ uiFontSize: $event })" />
  </SettingRow>
  <SettingRow id="glass-opacity" control="rm-glass-opacity" resettable @reset="change({ glassOpacity: DEFAULTS.glassOpacity })">
    <el-slider id="rm-glass-opacity" :min="0.4" :max="1" :step="0.05" :model-value="settings.glassOpacity" @change="change({ glassOpacity: Number($event) })" /><output for="rm-glass-opacity">{{ Math.round(settings.glassOpacity * 100) }}%</output>
  </SettingRow>
  <AppearanceSettings />
</template>

<style scoped lang="scss">
:deep(.el-slider) {
  width: 150px;
  margin: 0 10px;
}
</style>
