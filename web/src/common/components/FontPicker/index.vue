<script setup lang="ts">
import type { Settings } from '../../../pinia/stores/settings'
import { preferencesApi } from '@@/apis/preferences'
import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { computed, ref } from 'vue'
import { useUserStore } from '@/pinia/stores/user'
import { loadSettings, settings, SettingsAppearanceError, updateSettings } from '../../../pinia/stores/settings'
import { customFonts, loadFonts } from '../../appearance/fonts'
import { FONT_PRESETS } from '../../appearance/typography'
import Icon from '../Icon/index.vue'

const props = defineProps<{ id: string, setting: 'uiFont' | 'textFont' | 'codeFont' }>()
const user = useUserStore()
const expanded = ref(false)
const busy = ref(false)
const error = ref('')
const fileInput = ref<HTMLInputElement>()
const fonts = computed(() => [
  ...Object.entries(FONT_PRESETS).filter(([id]) => !settings.hiddenFonts.includes(id)).map(([id, font]) => ({ id, name: font.label })),
  ...customFonts.value,
])
const selected = computed(() => fonts.value.find(font => font.id === settings[props.setting]) ?? { id: 'maple', name: FONT_PRESETS.maple.label })

async function choose(id: string) {
  error.value = ''
  busy.value = true
  try {
    if (await save({ [props.setting]: id })) expanded.value = false
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
      error.value += `；重新读取设置失败：${String(reload)}`
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
    if (file.size > 30 * 1024 * 1024) throw new Error('字体文件超过 30 MB')
    if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('请选择 TTF、OTF、WOFF 或 WOFF2 字体')
    // 让浏览器校验实际字体；无效字体不会上传或进入页面的字体加载集合。
    const data = await file.arrayBuffer()
    try {
      await new FontFace('rawmark-import-check', data).load()
    } catch (cause) {
      throw new Error('无法解析字体文件，请选择有效的字体。', { cause })
    }
    user.assertSession(version)
    const font = await preferencesApi.importFont(file)
    await loadFonts()
    user.assertSession(version)
    if (!await save({ [props.setting]: font.id })) return
    expanded.value = false
    toast('字体已导入')
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
      await preferencesApi.deleteFont(id)
      await loadSettings()
    }
    toast('字体已删除，使用它的位置已恢复 Maple')
  } catch (cause) {
    if (isCancel(cause)) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && expanded.value) {
    event.stopPropagation(); expanded.value = false
  }
}
</script>

<template>
  <div class="rm-font-picker" @keydown="onKey">
    <el-button :id="id" class="rm-btn rm-font-trigger" :aria-expanded="expanded" :aria-controls="`${id}-options`" :disabled="busy" @click="expanded = !expanded">
      <span>{{ selected.name }}</span><Icon name="chevron" />
    </el-button>
    <div v-if="expanded" :id="`${id}-options`" class="rm-font-options">
      <div v-for="font in fonts" :key="font.id" class="rm-font-option">
        <button class="rm-font-choice" :class="{ on: font.id === settings[setting] }" :aria-pressed="font.id === settings[setting]" :disabled="busy" @click="choose(font.id)">
          <span>{{ font.name }}</span><small v-if="font.id === 'maple'">默认</small>
        </button>
        <button v-if="font.id !== 'maple'" class="rm-icon-btn" :aria-label="`删除字体 ${font.name}`" title="删除字体" :disabled="busy" @click="remove(font.id)">
          <Icon name="trash" />
        </button>
      </div>
      <el-button class="rm-btn rm-font-import" :disabled="busy" @click="fileInput!.click()">
        <Icon name="import" />{{ busy ? '处理中…' : '导入字体' }}
      </el-button>
      <p class="rm-share-note">
        支持 TTF、OTF、WOFF、WOFF2，单个文件不超过 30 MB。
      </p>
    </div>
    <input ref="fileInput" type="file" accept=".ttf,.otf,.woff,.woff2" hidden :aria-label="`导入字体 ${id}`" @change="importFont">
    <p v-if="error" class="rm-auth-error" role="alert">
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.rm-font-picker {
  position: relative;
  width: 260px;
  max-width: 100%;
  min-width: 0;
}
.rm-font-trigger {
  width: 100%;
  justify-content: space-between;
  text-align: left;
}
.rm-font-trigger span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rm-font-options {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 10;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--rm-divider);
  border-radius: 8px;
  padding: var(--rm-space-1);
  max-height: min(320px, 45dvh);
  overflow: auto;
  background: var(--rm-bg);
  box-shadow: var(--rm-shadow);
}
.rm-font-option {
  display: flex;
  align-items: center;
  gap: var(--rm-space-1);
}
.rm-font-choice {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  text-align: left;
  overflow-wrap: anywhere;
  min-height: var(--rm-control-size);
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.rm-font-choice span {
  flex: 1;
  min-width: 0;
}
.rm-font-choice:hover,
.rm-font-choice.on {
  background: var(--rm-hover);
}
.rm-font-choice small {
  flex: none;
  margin-left: 8px;
  color: var(--rm-text-muted);
  white-space: nowrap;
}
.rm-font-import {
  width: 100%;
  margin-top: var(--rm-space-1);
}
.rm-font-options p {
  margin: var(--rm-space-2);
}
@media (pointer: coarse) {
  .rm-font-choice {
    min-height: 44px;
  }
}
</style>
