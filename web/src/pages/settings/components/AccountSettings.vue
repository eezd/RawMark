<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus'

import { changePasswordApi } from '@@/apis/auth'
import Icon from '@@/components/Icon/index.vue'
import { t as translate } from '@@/i18n/runtime'
import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { reactive, ref } from 'vue'
import { useUserStore } from '@/pinia/stores/user'
import SettingRow from './SettingRow.vue'
import TokensPanel from './TokensPanel.vue'

defineEmits<{ logout: [] }>()
const user = useUserStore()
const form = ref<FormInstance>()
const fields = reactive({ current: '', next: '', confirm: '' })
const rules: FormRules<typeof fields> = {
  current: [{ required: true, get message() {
    return translate('settings.enter_your_current_password_f1790d')
  }, trigger: 'blur' }],
  next: [{ required: true, min: 8, get message() {
    return translate('settings.new_password_must_contain_at_2f1f54')
  }, trigger: 'blur' }],
  confirm: [{ validator: (_rule, value: string, callback) => callback(value !== fields.next ? new Error(translate('settings.new_passwords_do_not_match_c5575a')) : undefined), trigger: 'blur' }],
}
const error = ref('')
const busy = ref(false)
async function submit() {
  if (busy.value) return
  busy.value = true; error.value = ''
  const owner = user.getSessionVersion()
  try {
    if (!await new Promise<boolean>(resolve => form.value!.validate(valid => resolve(valid)))) return
    user.assertSession(owner)
    await changePasswordApi({ current: fields.current, next: fields.next })
    Object.assign(fields, { current: '', next: '', confirm: '' })
    form.value!.clearValidate()
    toast(translate('settings.password_changed_other_devices_must_04f0de'))
  } catch (cause) {
    if (!isCancel(cause)) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section id="rm-setting-password" tabindex="-1">
    <h3 class="rm-settings-group-title">
      {{ translate('settings.change_password_81ecab') }}
    </h3>
    <p class="rm-share-note">
      {{ translate('settings.other_devices_must_sign_in_2c516e') }}
    </p>
    <el-form ref="form" class="rm-account-form" :model="fields" :rules="rules" :disabled="busy" label-position="top" @submit.prevent="submit">
      <el-form-item :label="translate('settings.current_password_a114cf')" prop="current">
        <el-input v-model="fields.current" type="password" autocomplete="current-password" show-password />
      </el-form-item>
      <el-form-item :label="translate('settings.new_password_515e9c')" prop="next">
        <el-input v-model="fields.next" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <el-form-item :label="translate('settings.confirm_new_password_6fde05')" prop="confirm">
        <el-input v-model="fields.confirm" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <p v-if="error" class="rm-auth-error" role="alert">
        {{ error }}
      </p>
      <el-button native-type="submit" type="primary" :loading="busy">
        {{ translate('settings.change_password_08d008') }}
      </el-button>
    </el-form>
  </section>
  <section id="rm-setting-tokens" tabindex="-1">
    <h3 class="rm-settings-group-title">
      {{ translate('common.api_tokens_79db53') }}
    </h3><TokensPanel />
  </section>
  <SettingRow id="logout">
    <el-button @click="$emit('logout')">
      <Icon name="logout" />{{ translate('common.sign_out_498e1d') }}
    </el-button>
  </SettingRow>
</template>

<style scoped lang="scss">
.rm-account-form {
  max-width: 440px;
  margin-bottom: 24px;
}
</style>
