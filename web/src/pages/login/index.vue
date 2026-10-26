<script setup lang="ts">
import type { Captcha } from '@@/apis/auth/type'

import type { FormInstance, FormRules } from 'element-plus'

import { getCaptchaApi, loginApi, setupApi } from '@@/apis/auth'
import AppStatus from '@@/components/AppStatus/index.vue'
import { isCancel } from 'axios'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError } from '@/http/axios'
import { useUserStore } from '@/pinia/stores/user'
import { loginRedirect } from '@/router/guard'

const route = useRoute()
const router = useRouter()
const user = useUserStore()
const isSetup = computed(() => route.name === 'Setup')
const form = ref<FormInstance>()
const fields = reactive({ password: '', confirm: '', captchaCode: '' })
const rules: FormRules<typeof fields> = {
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }, { validator: (_rule, value: string, callback) => callback(isSetup.value && value.length < 8 ? new Error('密码至少 8 位') : undefined), trigger: 'blur' }],
  confirm: [{ validator: (_rule, value: string, callback) => callback(value !== fields.password ? new Error('两次输入的密码不一致') : undefined), trigger: 'blur' }],
  captchaCode: [{ pattern: /^\d{6}$/, required: true, message: '请输入六位数字验证码', trigger: 'blur' }],
}
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
  fields.captchaCode = ''
  try {
    const result = (await getCaptchaApi({ replaceId: captcha.value?.captchaId })).data
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
  form.value?.clearValidate()
}, { immediate: true })
onBeforeUnmount(() => {
  ++refreshID
})
async function submit() {
  if (busy.value || (!isSetup.value && (!captcha.value || refreshing.value))) return
  error.value = ''
  busy.value = true
  const owner = user.getSessionVersion()
  try {
    if (!await new Promise<boolean>(resolve => form.value!.validate(valid => resolve(valid)))) return
    user.assertSession(owner)
    const result = isSetup.value ? (await setupApi({ password: fields.password })).data : (await loginApi({ password: fields.password, captchaId: captcha.value!.captchaId, captchaCode: fields.captchaCode })).data
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
    <el-form ref="form" class="rm-auth-card" :model="fields" :rules="rules" label-position="top" :disabled="busy" @submit.prevent="submit">
      <h1>RawMark</h1>
      <p class="rm-auth-hint">
        {{ isSetup ? '首次使用，请设置登录密码。' : '登录你的 Markdown 知识库' }}
      </p>
      <el-form-item label="密码" prop="password">
        <el-input v-model="fields.password" type="password" :autocomplete="isSetup ? 'new-password' : 'current-password'" autofocus show-password />
      </el-form-item>
      <el-form-item v-if="isSetup" label="确认密码" prop="confirm">
        <el-input v-model="fields.confirm" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <template v-else>
        <el-form-item label="验证码" prop="captchaCode">
          <el-input v-model="fields.captchaCode" autocomplete="off" inputmode="numeric" maxlength="6" placeholder="输入图片中的六位数字" />
        </el-form-item>
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
    </el-form>
  </div>
</template>

<style scoped lang="scss">
.rm-auth-card :deep(.el-form-item) {
  margin-bottom: 18px;
}
.rm-auth-card :deep(.el-form-item__label) {
  color: var(--rm-text);
}
.rm-auth {
  font-family: var(--rm-font-text);
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
