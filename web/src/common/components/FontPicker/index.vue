<script setup lang="ts">
import type { Settings } from '@/pinia/stores/settings'

import { deleteFontApi, importFontApi } from '@@/apis/fonts'

import { t as translate } from '@@/i18n/runtime'

import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { computed, ref } from 'vue'
import { pinia } from '@/pinia'
import { SettingsAppearanceError, useSettingsStore } from '@/pinia/stores/settings'
import { useUserStore } from '@/pinia/stores/user'
import { customFonts, loadFonts } from '../../appearance/fonts'
import { FONT_PRESETS } from '../../appearance/typography'
import Icon from '../Icon/index.vue'

const props = defineProps<{ id: string, setting: 'uiFont' | 'textFont' | 'codeFont' }>()

const { loadSettings, settings, updateSettings } = useSettingsStore(pinia)

const user = useUserStore()
const busy = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()
const fonts = computed(() => [
  ...Object.entries(FONT_PRESETS).filter(([id]) => !settings.hiddenFonts.includes(id)).map(([id, font]) => ({ id, name: font.label })),
  ...customFonts.value,
])

async function choose(id: string) {
  error.value = ''
  busy.value = true
  try {
    await save({ [props.setting]: id })
  } finally {
    busy.value = false
  }
}

async function save(patch: Partial<Settings>) {
  try {
    await updateSettings(patch); return true
  } catch (cause) {
    if (isCancel(cause)) return false
    if (cause instanceof SettingsAppearanceError) {
      toast(cause.message); return true
    }
    error.value = cause instanceof Error ? cause.message : String(cause)
    try {
      await loadSettings()
    } catch (reload) {
      error.value += translate('common.could_not_reload_settings_86605a', { p0: String(reload) })
    }
    return false
  }
}

async function importFont(event: Event) {
  const version = user.getSessionVersion()
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  busy.value = true
  error.value = ''
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error(translate('common.font_files_must_not_exceed_cc001c'))
    if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error(translate('common.choose_a_ttf_otf_woff_eb6ab7'))
    // 让浏览器校验实际字体；无效字体不会上传或进入页面的字体加载集合。
    const data = await file.arrayBuffer()
    try {
      await new FontFace('rawmark-import-check', data).load()
    } catch (cause) {
      throw new Error(translate('common.could_not_read_this_font_ecc62f'), { cause })
    }
    user.assertSession(version)
    const font = (await importFontApi(file)).data
    await loadFonts()
    user.assertSession(version)
    if (!await save({ [props.setting]: font.id })) return
    toast(translate('common.font_imported_3dc232'))
  } catch (cause) {
    if (isCancel(cause)) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  busy.value = true
  error.value = ''
  try {
    if (Object.hasOwn(FONT_PRESETS, id)) {
      const patch: Partial<typeof settings> = { hiddenFonts: [...settings.hiddenFonts, id] }
      for (const key of ['uiFont', 'textFont', 'codeFont'] as const) {
        if (settings[key] === id) patch[key] = 'maple'
      }
      if (!await save(patch)) return
    } else {
      await deleteFontApi(id)
      await loadSettings()
    }
    toast(translate('common.font_deleted_its_uses_have_b83e92'))
  } catch (cause) {
    if (isCancel(cause)) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="rm-font-picker">
    <el-select :id="id" :model-value="settings[setting]" :disabled="busy" :loading="busy" filterable popper-class="rm-font-options" @change="choose">
      <el-option v-for="font in fonts" :key="font.id" :label="font.name" :value="font.id">
        <div class="rm-font-option">
          <span>{{ font.name }}</span><small v-if="font.id === 'maple'">{{ translate('common.default_844b8c') }}</small>
          <el-button v-else text size="small" :aria-label="translate('common.delete_font_3a6b32', { p0: font.name })" :disabled="busy" @mousedown.prevent.stop @click.stop="remove(font.id)">
            <Icon name="trash" />
          </el-button>
        </div>
      </el-option>
      <template #footer>
        <el-button class="rm-font-import" :disabled="busy" @click="fileInput!.click()">
          <Icon name="import" />{{ translate('common.import_font_50751a') }}
        </el-button>
        <p class="rm-share-note">
          {{ translate('common.ttf_otf_woff_or_woff_0cc484') }}
        </p>
      </template>
    </el-select>
    <input ref="fileInput" type="file" accept=".ttf,.otf,.woff,.woff2" hidden :aria-label="translate('common.import_font_183cd9', { p0: id })" @change="importFont">
    <p v-if="error" class="rm-auth-error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.rm-font-picker {
  width: 260px;
  max-width: 100%;
  min-width: 0;
}
.rm-font-option {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-font-option > span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rm-font-option small {
  color: var(--rm-text-muted);
}
.rm-font-import {
  width: 100%;
}
.rm-share-note {
  margin: 8px 0 0;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
}
</style>
