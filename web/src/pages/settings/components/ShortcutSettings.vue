<script setup lang="ts">
import type { Command } from '@@/utils/commands'

import Icon from '@@/components/Icon/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { allCommands, commandKeys, formatKeys, shortcutConflict } from '@@/utils/commands'
import { recordedKeys } from '@@/utils/keys'
import { toast } from '@@/utils/notifications'
import { computed, nextTick, ref, watch } from 'vue'
import { pinia } from '@/pinia'
import { SettingsAppearanceError, useSettingsStore } from '@/pinia/stores/settings'

const { loadSettings, settings, updateSettings } = useSettingsStore(pinia)

const commands = computed(allCommands)
const query = ref('')
const filteredCommands = computed(() => {
  const terms = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return commands.value.filter((command) => {
    const text = [command.title, command.id, ...commandKeys(command).map(formatKeys)].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
})
const recording = ref<string | null>(null)
const recorder = ref<HTMLInputElement>()
const error = ref('')
const busy = ref(false)
watch(query, () => {
  recording.value = null; error.value = ''
})

async function save(shortcuts: Record<string, string[]>) {
  busy.value = true
  try {
    await updateSettings({ shortcuts })
  } catch (cause) {
    if (cause instanceof SettingsAppearanceError) {
      toast(cause.message); return
    }
    toast(translate('settings.could_not_save_shortcuts_d58683', { p0: cause instanceof Error ? cause.message : String(cause) }))
    await loadSettings().catch(cause => toast(translate('settings.could_not_reload_settings_744b6a', { p0: String(cause) })))
  } finally {
    busy.value = false
  }
}

async function record(id: string) {
  error.value = ''
  recording.value = id
  await nextTick()
  recorder.value?.focus()
}

async function capture(event: KeyboardEvent, command: Command) {
  if (event.key === 'Escape') {
    recording.value = null; return
  }
  const key = recordedKeys(event)
  if (!key) return
  const conflict = shortcutConflict(command.id, [key])
  if (conflict) {
    error.value = translate('settings.conflicts_with_choose_a_different_b5848b', { p0: conflict.title }); return
  }
  const keys = [...new Set([...commandKeys(command), key])]
  recording.value = null
  await save({ ...settings.shortcuts, [command.id]: keys })
}

async function reset(command: Command) {
  const conflict = shortcutConflict(command.id, command.keys ?? [])
  if (conflict) {
    error.value = translate('settings.the_default_shortcut_conflicts_with_a89537', { p0: conflict.title }); return
  }
  const next = { ...settings.shortcuts }
  delete next[command.id]
  error.value = ''
  await save(next)
}
</script>

<template>
  <div class="rm-shortcut-settings">
    <div class="rm-shortcut-toolbar">
      <el-input v-model="query" type="search" clearable :aria-label="translate('settings.search_shortcuts_49504f')" :placeholder="translate('settings.search_commands_or_shortcuts_890754')" /><el-button class="rm-btn" :disabled="busy" @click="recording = null; error = ''; save({})">
        {{ translate('settings.reset_all_shortcuts_1853c7') }}
      </el-button>
    </div>
    <p class="rm-share-note">
      {{ translate('settings.click_add_then_press_a_cf4a60') }}
    </p>
    <p class="rm-share-note">
      {{ translate('settings.browsers_may_reserve_ctrl_cmd_8d4bc8') }}
    </p>
    <p class="rm-settings-result-count" role="status">
      {{ filteredCommands.length }} / {{ commands.length }} {{ translate('settings.commands_6aa9ce') }}{{ filteredCommands.length ? '' : translate('settings.no_matching_shortcuts_7e3955') }}
    </p>
    <p v-if="error" role="alert" class="rm-auth-error">
      {{ error }}
    </p>
    <div v-for="command in filteredCommands" :key="command.id" class="rm-shortcut-row">
      <span class="rm-shortcut-title">{{ command.title }}<small>{{ command.id }}</small></span>
      <div class="rm-shortcut-bindings">
        <span v-for="(key, index) in commandKeys(command)" :key="key" class="rm-shortcut-chip">
          <kbd>{{ formatKeys(key) }}</kbd>
          <button class="rm-icon-btn" :disabled="busy" :aria-label="translate('settings.remove_from_6909d6', { p0: command.title, p1: formatKeys(key) })" @click="save({ ...settings.shortcuts, [command.id]: commandKeys(command).filter((_, i) => i !== index) })"><Icon name="close" :size="16" /></button>
        </span>
        <input v-if="recording === command.id" :ref="(el) => { recorder = el as HTMLInputElement }" data-shortcut-recorder readonly :aria-label="translate('settings.press_a_shortcut_662b79')" :placeholder="translate('settings.press_a_shortcut_652436')" @keydown.prevent.stop="capture($event, command)" @blur="recording = null">
        <el-button v-else class="rm-btn" :disabled="busy" @click="record(command.id)">
          {{ translate('settings.add_7a8a11') }}
        </el-button>
        <el-button class="rm-btn" :disabled="busy" @click="reset(command)">
          {{ translate('settings.reset_cb5d68') }}
        </el-button>
      </div>
    </div>
  </div>
</template>
