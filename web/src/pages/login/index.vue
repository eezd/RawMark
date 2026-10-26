<script setup lang="ts">
import type { Captcha } from '@@/apis/auth/type'

import type { FormInstance, FormRules } from 'element-plus'

import { getCaptchaApi, loginApi, setupApi } from '@@/apis/auth'

import AppStatus from '@@/components/AppStatus/index.vue'
import LocaleSelect from '@@/components/LocaleSelect/index.vue'
import { chooseAnonymousLocale, locale, t as translate } from '@@/i18n/runtime'
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
const rules = computed<FormRules<typeof fields>>(() => ({
  password: [{ required: true, get message() {
    return translate('login.enter_your_password_728a7b')
  }, trigger: 'blur' }, { validator: (_rule, value: string, callback) => callback(isSetup.value && value.length < 8 ? new Error(translate('login.password_must_contain_at_least_8c1f11')) : undefined), trigger: 'blur' }],
  confirm: [{ validator: (_rule, value: string, callback) => callback(value !== fields.password ? new Error(translate('login.passwords_do_not_match_588077')) : undefined), trigger: 'blur' }],
  captchaCode: [{ pattern: /^\d{6}$/, required: true, get message() {
    return translate('login.enter_the_six_digit_verification_d746b8')
  }, trigger: 'blur' }],
}))
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
watch(locale, () => form.value?.clearValidate())
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
    if (typeof result.token !== 'string' || !result.token.startsWith('rms_') || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error(translate('login.invalid_login_response_b83520'))
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
      <LocaleSelect @change="chooseAnonymousLocale" />
      <p class="rm-auth-hint">
        {{ isSetup ? translate('login.welcome_set_a_password_to_cb8457') : translate('login.sign_in_to_your_markdown_4bb381') }}
      </p>
      <el-form-item :label="translate('login.password_a621ab')" prop="password">
        <el-input v-model="fields.password" type="password" :autocomplete="isSetup ? 'new-password' : 'current-password'" autofocus show-password />
      </el-form-item>
      <el-form-item v-if="isSetup" :label="translate('login.confirm_password_81b17b')" prop="confirm">
        <el-input v-model="fields.confirm" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <template v-else>
        <el-form-item :label="translate('login.verification_code_bb015c')" prop="captchaCode">
          <el-input v-model="fields.captchaCode" autocomplete="off" inputmode="numeric" maxlength="6" :placeholder="translate('login.enter_the_six_digits_in_bb5543')" />
        </el-form-item>
        <div class="rm-captcha">
          <el-button :disabled="refreshing || busy" class="rm-captcha-image" :aria-label="translate('login.refresh_verification_code_bc5b83')" @click="refresh">
            <img v-if="captcha" :src="captcha.imageDataUrl" :alt="translate('login.login_verification_code_3060b7')"><span v-else>{{ refreshing ? translate('login.loading_verification_code_8a7493') : translate('login.click_to_reload_the_verification_97c218') }}</span>
          </el-button>
          <el-button text :disabled="refreshing || busy" @click="refresh">
            {{ translate('login.refresh_code_fa28ea') }}
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
        {{ isSetup ? translate('login.finish_setup_fda1eb') : translate('common.sign_in_1e2df9') }}
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
