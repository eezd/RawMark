<script setup lang="ts">
import type { ApiToken } from '@@/apis/tokens/type'
import type { FormInstance, FormRules } from 'element-plus'

import { createTokenApi, deleteTokenApi, getTokensApi } from '@@/apis/tokens'
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
const rules: FormRules<typeof fields> = { name: [{ required: true, whitespace: true, message: '请输入令牌名称', trigger: 'blur' }] }
const user = useUserStore()
const busy = ref(false)
// 刚创建的令牌明文，只在本次对话框中显示
const created = ref<string | null>(null)
const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : '网络错误，请检查连接'
}

async function load() {
  if (loading.value) return
  loading.value = true; error.value = ''
  try {
    tokens.value = (await getTokensApi()).data.tokens
  } catch (cause) {
    if (!isCancel(cause)) error.value = `读取 API 令牌失败：${errorText(cause)}`
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
    toast(`创建失败：${errorText(err)}`)
  } finally {
    busy.value = false
  }
}

async function copy() {
  toast((await copyText(created.value!)) ? '令牌已复制' : '复制失败，请手动选中复制')
}

async function revoke(t: ApiToken) {
  if (busy.value) return
  busy.value = true
  try {
    if (!await confirmAction(`吊销“${t.name}”？使用它的脚本将立即无法访问。`)) return
    await deleteTokenApi(t.id)
    tokens.value = tokens.value!.filter(x => x.id !== t.id)
  } catch (err) {
    if (isCancel(err)) return
    toast(`吊销失败：${errorText(err)}`)
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <el-form ref="form" class="rm-token-form" :model="fields" :rules="rules" :disabled="busy" label-position="top" @submit.prevent="create">
      <el-form-item label="名称" prop="name">
        <el-input v-model="fields.name" autocomplete="off" placeholder="如：备份脚本" maxlength="100" />
      </el-form-item>
      <el-form-item label="权限">
        <el-select v-model="fields.scope" aria-label="权限">
          <el-option value="read" label="只读" /><el-option value="write" label="读写" />
        </el-select>
      </el-form-item>
      <el-button class="rm-btn rm-btn-primary" native-type="submit" :disabled="busy">
        创建
      </el-button>
    </el-form>
    <div v-if="created" class="rm-token-created">
      <p>令牌只显示这一次，请立即保存：</p>
      <div class="rm-token-value">
        <code>{{ created }}</code>
        <el-button class="rm-btn" @click="copy">
          复制
        </el-button>
      </div>
    </div>
    <p class="rm-share-note">
      调用时带上请求头 <code>Authorization: Bearer 令牌</code>；只读令牌只能读取。接口说明见
      <a href="/api/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a>。
    </p>
    <p v-if="error" class="rm-auth-error" role="alert">
      {{ error }} <el-button text :disabled="loading" @click="load">
        重试
      </el-button>
    </p>
    <p v-if="loading" role="status">
      读取中…
    </p>
    <el-table v-else-if="tokens" :data="tokens" row-key="id" empty-text="还没有 API 令牌">
      <!-- @vue-generic {ApiToken} -->
      <el-table-column label="名称" min-width="140">
        <template #default="{ row: token }">
          <strong>{{ token.name }}</strong><small class="rm-token-time">{{ fmt.format(token.createdAt) }} 创建 · {{ token.lastUsedAt ? `${fmt.format(token.lastUsedAt)} 最近使用` : '从未使用' }}</small>
        </template>
      </el-table-column>
      <!-- @vue-generic {ApiToken} -->
      <el-table-column label="权限" width="70">
        <template #default="{ row: token }">
          {{ token.scope === 'write' ? '读写' : '只读' }}
        </template>
      </el-table-column>
      <!-- @vue-generic {ApiToken} -->
      <el-table-column label="操作" width="70">
        <template #default="{ row: token }">
          <el-button text type="danger" :disabled="busy" @click="revoke(token)">
            吊销
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
