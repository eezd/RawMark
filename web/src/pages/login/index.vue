<script setup lang="ts">
import type { Captcha } from '@@/apis/auth'
import { authApi } from '@@/apis/auth'
import AppStatus from '@@/components/AppStatus.vue'
import { isCancel } from 'axios'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/http/axios'
import { useUserStore } from '@/pinia/stores/user'
import { loginRedirect } from '@/router/guard'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const isSetup = computed(() => route.name === 'Setup')
const password = ref('')
const confirm = ref('')
const captchaCode = ref('')
const captcha = ref<Captcha>()
const captchaError = ref('')
const error = ref('')
const busy = ref(false)
const refreshing = ref(false)
let refreshID = 0
async function refresh() {
  const id = ++refreshID
  refreshing.value = true
  captchaError.value = ''
  captchaCode.value = ''
  try {
    const result = await authApi.captcha(captcha.value?.captchaId)
    if (id === refreshID) captcha.value = result
  } catch (cause) {
    if (id === refreshID && !isCancel(cause)) {
      captcha.value = undefined; captchaError.value = cause instanceof Error ? cause.message : String(cause)
    }
  } finally {
    if (id === refreshID) refreshing.value = false
  }
}
watch(isSetup, (setup) => {
  ++refreshID; captcha.value = undefined; error.value = ''; if (!setup) void refresh()
}, { immediate: true })
async function submit() {
  if (busy.value || (!isSetup.value && (!captcha.value || refreshing.value))) return
  error.value = ''
  if (isSetup.value && password.value !== confirm.value) {
    error.value = '两次输入的密码不一致'; return
  }
  busy.value = true
  try {
    const result = isSetup.value ? await authApi.setup(password.value) : await authApi.login(password.value, captcha.value!.captchaId, captchaCode.value)
    if (typeof result.token !== 'string' || !result.token.startsWith('rms_') || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('登录响应格式错误')
    user.setToken(result.token)
    const version = user.getSessionVersion()
    await user.getInfo()
    user.assertSession(version)
    await router.replace(loginRedirect(route.query.redirect))
  } catch (cause) {
    if (!isCancel(cause)) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      if (!isSetup.value && !(cause instanceof ApiError && cause.status === 429)) await refresh()
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppStatus />
  <div class="rm-auth">
    <form class="rm-auth-card" @submit.prevent="submit">
      <h1>RawMark</h1>
      <p class="rm-auth-hint">
        {{ isSetup ? '首次使用，请设置登录密码。' : '登录你的 Markdown 知识库' }}
      </p>
      <label><span>密码</span><el-input v-model="password" type="password" :autocomplete="isSetup ? 'new-password' : 'current-password'" required autofocus show-password /></label>
      <label v-if="isSetup"><span>确认密码</span><el-input v-model="confirm" type="password" autocomplete="new-password" required show-password /></label>
      <template v-else>
        <label><span>验证码</span><el-input v-model="captchaCode" autocomplete="off" inputmode="numeric" maxlength="6" required placeholder="输入图片中的六位数字" /></label>
        <div class="rm-captcha">
          <el-button :disabled="refreshing || busy" class="rm-captcha-image" aria-label="刷新验证码" @click="refresh">
            <img v-if="captcha" :src="captcha.imageDataUrl" alt="登录验证码"><span v-else>{{ refreshing ? '正在加载验证码…' : '点击重新加载验证码' }}</span>
          </el-button>
          <el-button text :disabled="refreshing || busy" @click="refresh">
            换一张
          </el-button>
        </div>
        <p v-if="captchaError" class="rm-auth-error" role="alert">
          {{ captchaError }}
        </p>
      </template>
      <p v-if="error" class="rm-auth-error" role="alert">
        {{ error }}
      </p>
      <el-button type="primary" native-type="submit" :loading="busy" :disabled="!isSetup && (!captcha || refreshing)">
        {{ isSetup ? '完成设置' : '登录' }}
      </el-button>
    </form>
  </div>
</template>

<style scoped>
.rm-auth {
  font-family: 'Maple Mono Normal NL NF CN', monospace;
}
.rm-captcha {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rm-captcha-image {
  height: 80px;
  padding: 0;
  flex: 1;
  overflow: hidden;
}
.rm-captcha-image img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
