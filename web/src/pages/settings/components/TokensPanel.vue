<script setup lang="ts">
import type { ApiToken } from '@/pages/settings/apis/type'
import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { onMounted, ref } from 'vue'
import { ApiError } from '@/http/axios'
import { settingsApi } from '@/pages/settings/apis'
import Icon from '../../../common/components/Icon/index.vue'
import { copyText } from '../../../common/utils/clipboard'

const tokens = ref<ApiToken[] | null>(null)
const failed = ref(false)
const name = ref('')
const scope = ref<ApiToken['scope']>('read')
const busy = ref(false)
// 刚创建的令牌明文，只在本次对话框中显示
const created = ref<string | null>(null)
const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : '网络错误，请检查连接'
}

async function load() {
  try {
    tokens.value = await settingsApi.tokens()
  } catch {
    failed.value = true
  }
}

async function create() {
  busy.value = true
  try {
    const res = await settingsApi.createToken(name.value.trim(), scope.value)
    tokens.value = [res.info, ...(tokens.value ?? [])]
    created.value = res.token
    name.value = ''
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
  if (!confirm(`吊销“${t.name}”？使用它的脚本将立即无法访问。`)) return
  try {
    await settingsApi.deleteToken(t.id)
    tokens.value = tokens.value!.filter(x => x.id !== t.id)
  } catch (err) {
    if (isCancel(err)) return
    toast(`吊销失败：${errorText(err)}`)
  }
}

onMounted(load)
</script>

<template>
  <div>
    <form class="rm-share-form" @submit.prevent="create">
      <el-input v-model="name" type="text" autocomplete="off" placeholder="名称，如：备份脚本" aria-label="名称" required maxlength="100" />
      <el-select v-model="scope" aria-label="权限">
        <el-option value="read" label="只读" /><el-option value="write" label="读写" />
      </el-select>
      <el-button class="rm-btn rm-btn-primary" native-type="submit" :disabled="busy">
        创建
      </el-button>
    </form>
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
    <p v-if="failed" class="rm-tree-empty">
      读取 API 令牌失败
    </p>
    <p v-else-if="tokens && !tokens.length" class="rm-tree-empty">
      还没有 API 令牌
    </p>
    <ul v-else class="rm-trash-list">
      <li v-for="t in tokens ?? []" :key="t.id">
        <Icon name="key" />
        <div class="rm-trash-info">
          <span class="rm-trash-path">{{ t.name }} · {{ t.scope === 'write' ? '读写' : '只读' }}</span>
          <span class="rm-trash-time">
            {{ fmt.format(t.createdAt) }} 创建 · {{ t.lastUsedAt ? `${fmt.format(t.lastUsedAt)} 最近使用` : '从未使用' }}
          </span>
        </div>
        <el-button class="rm-btn rm-btn-danger" @click="revoke(t)">
          吊销
        </el-button>
      </li>
    </ul>
  </div>
</template>
