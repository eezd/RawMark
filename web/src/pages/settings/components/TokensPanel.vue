<script setup lang="ts">
import type { ApiToken } from '@@/apis/tokens/type'

import type { FormInstance, FormRules } from 'element-plus'
import { createTokenApi, deleteTokenApi, getTokensApi } from '@@/apis/tokens'

import { locale, t as translate } from '@@/i18n/runtime'
import { copyText } from '@@/utils/clipboard'
import { confirmAction } from '@@/utils/confirm'
import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { onMounted, reactive, ref } from 'vue'
import { ApiError } from '@/http/axios'
import { useUserStore } from '@/pinia/stores/user'

const tokens = ref<ApiToken[] | null>(null)
const error = ref('')
const loading = ref(false)
const form = ref<FormInstance>()
const fields = reactive({ name: '', scope: 'read' as ApiToken['scope'] })
const rules: FormRules<typeof fields> = { name: [{ required: true, whitespace: true, get message() {
  return translate('settings.enter_a_token_name_3d7107')
}, trigger: 'blur' }] }
const user = useUserStore()
const busy = ref(false)
// Plaintext of the newly created token, shown only in this dialog session.
const created = ref<string | null>(null)
const fmt = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'short', timeStyle: 'short' }))

function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : translate('common.network_error_check_your_connection_566064')
}

async function load() {
  if (loading.value) return
  loading.value = true; error.value = ''
  try {
    tokens.value = (await getTokensApi()).data.tokens
  } catch (cause) {
    if (!isCancel(cause)) error.value = translate('settings.could_not_load_api_tokens_98ef9a', { p0: errorText(cause) })
  } finally {
    loading.value = false
  }
}

async function create() {
  if (busy.value) return
  busy.value = true
  const owner = user.getSessionVersion()
  try {
    if (!await new Promise<boolean>(resolve => form.value!.validate(valid => resolve(valid)))) return
    user.assertSession(owner)
    const res = (await createTokenApi({ name: fields.name.trim(), scope: fields.scope })).data
    tokens.value = [res.info, ...(tokens.value ?? [])]
    created.value = res.token
    fields.name = ''; form.value!.clearValidate()
  } catch (err) {
    if (isCancel(err)) return
    toast(translate('settings.could_not_create_token_c6c409', { p0: errorText(err) }))
  } finally {
    busy.value = false
  }
}

async function copy() {
  toast((await copyText(created.value!)) ? translate('settings.token_copied_6cca3e') : translate('settings.copy_failed_select_and_copy_cbc861'))
}

async function revoke(t: ApiToken) {
  if (busy.value) return
  busy.value = true
  try {
    if (!await confirmAction(translate('settings.revoke_scripts_using_this_token_f32cc1', { p0: t.name }))) return
    await deleteTokenApi(t.id)
    tokens.value = tokens.value!.filter(x => x.id !== t.id)
  } catch (err) {
    if (isCancel(err)) return
    toast(translate('settings.could_not_revoke_token_8976da', { p0: errorText(err) }))
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <el-form ref="form" class="rm-token-form" :model="fields" :rules="rules" :disabled="busy" label-position="top" @submit.prevent="create">
      <el-form-item :label="translate('common.name_d44e9b')" prop="name">
        <el-input v-model="fields.name" autocomplete="off" :placeholder="translate('settings.e_g_backup_script_da8956')" maxlength="100" />
      </el-form-item>
      <el-form-item :label="translate('settings.permissions_978cbc')">
        <el-select v-model="fields.scope" :aria-label="translate('settings.permissions_978cbc')">
          <el-option value="read" :label="translate('settings.read_only_3b5ec3')" /><el-option value="write" :label="translate('settings.read_and_write_d5c332')" />
        </el-select>
      </el-form-item>
      <el-button class="rm-btn rm-btn-primary" native-type="submit" :disabled="busy">
        {{ translate('settings.create_cde2cd') }}
      </el-button>
    </el-form>
    <div v-if="created" class="rm-token-created">
      <p>{{ translate('settings.this_token_is_shown_only_88a1ba') }}</p>
      <div class="rm-token-value">
        <code>{{ created }}</code>
        <el-button class="rm-btn" @click="copy">
          {{ translate('common.copy_63d90d') }}
        </el-button>
      </div>
    </div>
    <p class="rm-share-note">
      {{ translate('settings.send_the_request_header_02d3d2') }} <code>{{ translate('settings.authorization_bearer_token_3abd9b') }}</code>{{ translate('settings.read_only_tokens_can_only_38418a') }}
      <a href="/api/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a>
    </p>
    <p v-if="error" class="rm-auth-error" role="alert">
      {{ error }} <el-button text :disabled="loading" @click="load">
        {{ translate('common.retry_b8784c') }}
      </el-button>
    </p>
    <p v-if="loading" role="status">
      {{ translate('settings.loading_346ff6') }}
    </p>
    <el-table v-else-if="tokens" :data="tokens" row-key="id" :empty-text="translate('settings.no_api_tokens_yet_6eae29')">
      <!-- @vue-generic {ApiToken} -->
      <el-table-column :label="translate('common.name_d44e9b')" min-width="140">
        <template #default="{ row: token }">
          <strong>{{ token.name }}</strong><small class="rm-token-time">{{ fmt.format(token.createdAt) }} {{ translate('settings.created_3567a7') }} {{ token.lastUsedAt ? translate('settings.last_used_b78fad', { p0: fmt.format(token.lastUsedAt) }) : translate('settings.never_used_458529') }}</small>
        </template>
      </el-table-column>
      <!-- @vue-generic {ApiToken} -->
      <el-table-column :label="translate('settings.permissions_978cbc')" width="70">
        <template #default="{ row: token }">
          {{ token.scope === 'write' ? translate('settings.read_and_write_d5c332') : translate('settings.read_only_3b5ec3') }}
        </template>
      </el-table-column>
      <!-- @vue-generic {ApiToken} -->
      <el-table-column :label="translate('settings.actions_ed31fb')" width="70">
        <template #default="{ row: token }">
          <el-button text type="danger" :disabled="busy" @click="revoke(token)">
            {{ translate('settings.revoke_d8c68b') }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped lang="scss">
.rm-token-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
  margin-top: 16px;
}
.rm-token-form :deep(.el-form-item) {
  flex: 1 1 140px;
  margin-bottom: 0;
  min-width: 0;
}
.rm-token-form :deep(.el-select) {
  width: 100%;
}
.rm-token-time {
  display: block;
  margin-top: 4px;
  font-size: var(--rm-ui-font-small);
  color: var(--rm-text-muted);
}
</style>
