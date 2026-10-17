<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ApiError } from './api'
import { WrongPasswordError } from './crypto'
import { changePassword, closeKeyDialog, keyState, setupKeyring, unlock } from './encryption'
import Icon from './Icon.vue'
import { toast } from './workspace'

// 与登录密码的最短长度一致（internal/auth MinPasswordLen）
const MIN_LENGTH = 8

const mode = computed(() => keyState.dialog!)
const title = computed(() => ({ unlock: '解锁加密笔记', setup: '设置加密密码', change: '修改加密密码' })[mode.value])
const current = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)
const form = ref<HTMLFormElement>()

// autofocus 对动态插入的元素不一定生效
onMounted(() => form.value?.querySelector('input')?.focus())

async function submit() {
  error.value = ''
  if (mode.value !== 'unlock') {
    if ([...password.value].length < MIN_LENGTH) return void (error.value = `密码至少 ${MIN_LENGTH} 个字符`)
    if (password.value !== confirm.value) return void (error.value = '两次输入的密码不一致')
  }
  busy.value = true
  try {
    if (mode.value === 'unlock') await unlock(password.value)
    else if (mode.value === 'setup') await setupKeyring(password.value)
    else {
      await changePassword(current.value, password.value)
      toast('加密密码已修改')
    }
    closeKeyDialog(true)
  } catch (err) {
    if (err instanceof WrongPasswordError) error.value = mode.value === 'change' ? '当前密码错误' : '密码错误'
    else if (err instanceof ApiError && err.status === 409) error.value = '加密密码已在其他地方设置，请关闭后重新解锁'
    else if (err instanceof ApiError && err.status === 412) error.value = '加密密码刚在其他地方被修改，请关闭后重试'
    else error.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="closeKeyDialog(false)">
    <div class="rm-dialog rm-key-dialog" role="dialog" :aria-label="title">
      <div class="rm-dialog-head">
        <h2>{{ title }}</h2>
        <button class="rm-icon-btn" title="关闭" @click="closeKeyDialog(false)"><Icon name="close" /></button>
      </div>
      <form ref="form" class="rm-auth-card rm-key-form" @submit.prevent="submit">
        <p v-if="mode === 'setup'" class="rm-auth-hint">
          加密密码与登录密码分开，所有加密笔记共用。<strong>忘记加密密码将无法恢复任何加密笔记</strong>，请妥善保管。
        </p>
        <p v-else-if="mode === 'change'" class="rm-auth-hint">修改后已加密的笔记无需重新加密，旧密码立即失效。</p>
        <label v-if="mode === 'change'">
          <span>当前密码</span>
          <input v-model="current" type="password" autocomplete="current-password" required />
        </label>
        <label>
          <span>{{ mode === 'change' ? '新密码' : '加密密码' }}</span>
          <input
            v-model="password"
            type="password"
            :autocomplete="mode === 'unlock' ? 'current-password' : 'new-password'"
            required
          />
        </label>
        <label v-if="mode !== 'unlock'">
          <span>确认密码</span>
          <input v-model="confirm" type="password" autocomplete="new-password" required />
        </label>
        <p v-if="error" class="rm-auth-error">{{ error }}</p>
        <button class="rm-btn rm-btn-primary" type="submit" :disabled="busy">
          {{ busy ? '处理中…' : mode === 'unlock' ? '解锁' : '确定' }}
        </button>
      </form>
    </div>
  </div>
</template>
