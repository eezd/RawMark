<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { copyText } from '../editor/widgets'
import { api, ApiError, type ApiToken } from './api'
import Icon from './Icon.vue'
import { toast } from './workspace'

const emit = defineEmits<{ close: [] }>()

const tokens = ref<ApiToken[] | null>(null)
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
    tokens.value = await api.tokens()
  } catch (err) {
    toast('读取 API 令牌失败：' + errorText(err))
    emit('close')
  }
}

async function create() {
  busy.value = true
  try {
    const res = await api.createToken(name.value.trim(), scope.value)
    tokens.value = [res.info, ...(tokens.value ?? [])]
    created.value = res.token
    name.value = ''
  } catch (err) {
    toast('创建失败：' + errorText(err))
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
    await api.deleteToken(t.id)
    tokens.value = tokens.value!.filter((x) => x.id !== t.id)
  } catch (err) {
    toast('吊销失败：' + errorText(err))
  }
}

onMounted(load)
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="emit('close')">
    <div class="rm-dialog rm-share-dialog" role="dialog" aria-label="API 令牌">
      <div class="rm-dialog-head">
        <h2>API 令牌</h2>
        <button class="rm-icon-btn" title="关闭" @click="emit('close')"><Icon name="close" /></button>
      </div>
      <form class="rm-share-form" @submit.prevent="create">
        <input v-model="name" type="text" autocomplete="off" placeholder="名称，如：备份脚本" aria-label="名称" required maxlength="100" />
        <select v-model="scope" aria-label="权限">
          <option value="read">只读</option>
          <option value="write">读写</option>
        </select>
        <button class="rm-btn rm-btn-primary" type="submit" :disabled="busy">创建</button>
      </form>
      <div v-if="created" class="rm-token-created">
        <p>令牌只显示这一次，请立即保存：</p>
        <div class="rm-token-value">
          <code>{{ created }}</code>
          <button class="rm-btn" @click="copy">复制</button>
        </div>
      </div>
      <p class="rm-share-note">
        调用时带上请求头 <code>Authorization: Bearer 令牌</code>；只读令牌只能读取。接口说明见
        <a href="/api/v1/openapi.json" target="_blank" rel="noopener">openapi.json</a>。
      </p>
      <p v-if="tokens && !tokens.length" class="rm-tree-empty">还没有 API 令牌</p>
      <ul v-else class="rm-trash-list">
        <li v-for="t in tokens ?? []" :key="t.id">
          <Icon name="key" />
          <div class="rm-trash-info">
            <span class="rm-trash-path">{{ t.name }} · {{ t.scope === 'write' ? '读写' : '只读' }}</span>
            <span class="rm-trash-time">
              {{ fmt.format(t.createdAt) }} 创建 · {{ t.lastUsedAt ? fmt.format(t.lastUsedAt) + ' 最近使用' : '从未使用' }}
            </span>
          </div>
          <button class="rm-btn rm-btn-danger" @click="revoke(t)">吊销</button>
        </li>
      </ul>
    </div>
  </div>
</template>
