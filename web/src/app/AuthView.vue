<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, ApiError } from './api'

const props = defineProps<{ mode: 'setup' | 'login' }>()
const emit = defineEmits<{ done: [] }>()

const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)
const isSetup = computed(() => props.mode === 'setup')

async function submit() {
  error.value = ''
  if (isSetup.value && password.value !== confirm.value) {
    error.value = '两次输入的密码不一致'
    return
  }
  busy.value = true
  try {
    if (isSetup.value) await api.setup(password.value)
    else await api.login(password.value)
    emit('done')
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : '网络错误，请检查连接'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="rm-auth">
    <form class="rm-auth-card" @submit.prevent="submit">
      <h1>RawMark</h1>
      <p v-if="isSetup" class="rm-auth-hint">
        首次使用，请设置登录密码。
      </p>
      <label>
        <span>密码</span>
        <input
          v-model="password"
          type="password"
          :autocomplete="isSetup ? 'new-password' : 'current-password'"
          :minlength="isSetup ? 8 : undefined"
          required
          autofocus
        />
      </label>
      <label v-if="isSetup">
        <span>确认密码</span>
        <input v-model="confirm" type="password" autocomplete="new-password" required />
      </label>
      <p v-if="error" class="rm-auth-error">{{ error }}</p>
      <button class="rm-btn rm-btn-primary" type="submit" :disabled="busy">{{ isSetup ? '完成设置' : '登录' }}</button>
    </form>
  </div>
</template>
