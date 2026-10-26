<script setup lang="ts">
import type { FormInstance, FormRules } from 'element-plus'
import { changePasswordApi } from '@@/apis/auth'
import Icon from '@@/components/Icon/index.vue'
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
  current: [{ required: true, message: '请输入当前密码', trigger: 'blur' }],
  next: [{ required: true, min: 8, message: '新密码至少 8 位', trigger: 'blur' }],
  confirm: [{ validator: (_rule, value: string, callback) => callback(value !== fields.next ? new Error('两次输入的新密码不一致') : undefined), trigger: 'blur' }],
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
    toast('登录密码已修改，其他设备需要重新登录')
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
      修改登录密码
    </h3>
    <p class="rm-share-note">
      修改后其他设备需要重新登录。
    </p>
    <el-form ref="form" class="rm-account-form" :model="fields" :rules="rules" :disabled="busy" label-position="top" @submit.prevent="submit">
      <el-form-item label="当前密码" prop="current">
        <el-input v-model="fields.current" type="password" autocomplete="current-password" show-password />
      </el-form-item>
      <el-form-item label="新密码" prop="next">
        <el-input v-model="fields.next" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <el-form-item label="确认新密码" prop="confirm">
        <el-input v-model="fields.confirm" type="password" autocomplete="new-password" show-password />
      </el-form-item>
      <p v-if="error" class="rm-auth-error" role="alert">
        {{ error }}
      </p>
      <el-button native-type="submit" type="primary" :loading="busy">
        修改密码
      </el-button>
    </el-form>
  </section>
  <section id="rm-setting-tokens" tabindex="-1">
    <h3 class="rm-settings-group-title">
      API 令牌
    </h3><TokensPanel />
  </section>
  <SettingRow id="logout">
    <el-button @click="$emit('logout')">
      <Icon name="logout" />退出
    </el-button>
  </SettingRow>
</template>

<style scoped lang="scss">
.rm-account-form {
  max-width: 440px;
  margin-bottom: 24px;
}
</style>
