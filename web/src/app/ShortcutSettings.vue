<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { allCommands, commandKeys, formatKeys, shortcutConflict, type Command } from './commands'
import { recordedKeys } from '../keys'
import { loadSettings, settings, updateSettings } from './settings'
import { toast } from './workspace'
import Icon from './Icon.vue'

const commands = computed(allCommands)
const recording = ref<string | null>(null)
const recorder = ref<HTMLInputElement>()
const error = ref('')
const busy = ref(false)

async function save(shortcuts: Record<string, string[]>) {
  busy.value = true
  try { await updateSettings({ shortcuts }) }
  catch (cause) {
    toast('保存快捷键失败：' + (cause instanceof Error ? cause.message : String(cause)))
    await loadSettings().catch((cause) => toast('重新读取设置失败：' + String(cause)))
  } finally { busy.value = false }
}

async function record(id: string) {
  error.value = ''
  recording.value = id
  await nextTick()
  recorder.value?.focus()
}

async function capture(event: KeyboardEvent, command: Command) {
  if (event.key === 'Escape') { recording.value = null; return }
  const key = recordedKeys(event)
  if (!key) return
  const conflict = shortcutConflict(command.id, [key])
  if (conflict) { error.value = `与“${conflict.title}”冲突，请换一个快捷键`; return }
  const keys = [...new Set([...commandKeys(command), key])]
  recording.value = null
  await save({ ...settings.shortcuts, [command.id]: keys })
}

async function reset(command: Command) {
  const conflict = shortcutConflict(command.id, command.keys ?? [])
  if (conflict) { error.value = `默认快捷键与“${conflict.title}”冲突，请先调整该命令`; return }
  const next = { ...settings.shortcuts }
  delete next[command.id]
  error.value = ''
  await save(next)
}
</script>

<template>
  <div class="rm-shortcut-settings">
    <button class="rm-btn" :disabled="busy" @click="recording = null; error = ''; save({})">重置全部快捷键</button>
    <p class="rm-share-note">点击添加后按下组合键，Esc 取消；× 移除绑定，重置恢复默认。设置在所有设备间同步。</p>
    <p v-if="error" role="alert" class="rm-auth-error">{{ error }}</p>
    <div v-for="command in commands" :key="command.id" class="rm-shortcut-row">
      <span>{{ command.title }}</span>
      <div class="rm-shortcut-bindings">
        <span v-for="(key, index) in commandKeys(command)" :key="key" class="rm-shortcut-chip">
          <kbd>{{ formatKeys(key) }}</kbd>
          <button class="rm-icon-btn" :disabled="busy" :aria-label="`移除${command.title}的${formatKeys(key)}`" @click="save({ ...settings.shortcuts, [command.id]: commandKeys(command).filter((_, i) => i !== index) })"><Icon name="close" :size="12" /></button>
        </span>
        <input v-if="recording === command.id" :ref="(el) => { recorder = el as HTMLInputElement }" data-shortcut-recorder readonly aria-label="按下快捷键" placeholder="按下快捷键…" @keydown.prevent.stop="capture($event, command)" @blur="recording = null" />
        <button v-else class="rm-btn" :disabled="busy" @click="record(command.id)">添加</button>
        <button class="rm-btn" :disabled="busy" @click="reset(command)">重置</button>
      </div>
    </div>
  </div>
</template>
