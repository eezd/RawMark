<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { copyText } from '../editor/widgets'
import { api, ApiError, type Share } from './api'
import Icon from './Icon.vue'
import { noteTitle } from './paths'
import { toast } from './workspace'

// path 为空时列出全部分享（管理列表），否则管理这一篇笔记的分享
const props = defineProps<{ path: string | null }>()
const emit = defineEmits<{ close: [] }>()

const EXPIRY_OPTIONS = [
  { label: '永久有效', seconds: 0 },
  { label: '1 天', seconds: 86400 },
  { label: '7 天', seconds: 7 * 86400 },
  { label: '30 天', seconds: 30 * 86400 },
]

const shares = ref<Share[] | null>(null)
const password = ref('')
const expiresIn = ref(0)
const busy = ref(false)
const title = computed(() => (props.path ? `分享“${noteTitle(props.path)}”` : '所有分享'))
const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })

const linkOf = (s: Share) => `${location.origin}/s/${s.token}`
const expired = (s: Share) => s.expiresAt !== 0 && s.expiresAt <= Date.now()

function errorText(err: unknown) {
  return err instanceof ApiError ? err.message : '网络错误，请检查连接'
}

async function load() {
  try {
    shares.value = await api.shares(props.path ?? undefined)
  } catch (err) {
    toast('读取分享失败：' + errorText(err))
    emit('close')
  }
}

async function create() {
  busy.value = true
  try {
    const s = await api.createShare(props.path!, password.value, expiresIn.value)
    shares.value = [s, ...(shares.value ?? [])]
    password.value = ''
    await copy(s)
  } catch (err) {
    toast('创建分享失败：' + errorText(err))
  } finally {
    busy.value = false
  }
}

async function copy(s: Share) {
  toast((await copyText(linkOf(s))) ? '链接已复制' : '复制失败，请手动复制链接')
}

async function revoke(s: Share) {
  if (!confirm('撤销后该链接立即失效，确定撤销？')) return
  try {
    await api.deleteShare(s.token)
    shares.value = shares.value!.filter((x) => x.token !== s.token)
  } catch (err) {
    toast('撤销失败：' + errorText(err))
  }
}

onMounted(load)
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="emit('close')">
    <div class="rm-dialog rm-share-dialog" role="dialog" :aria-label="title">
      <div class="rm-dialog-head">
        <h2>{{ title }}</h2>
        <button class="rm-icon-btn" title="关闭" @click="emit('close')"><Icon name="close" /></button>
      </div>
      <form v-if="path" class="rm-share-form" @submit.prevent="create">
        <input v-model="password" type="text" autocomplete="off" placeholder="访问密码（可选）" aria-label="访问密码" />
        <select v-model="expiresIn" aria-label="有效期">
          <option v-for="o in EXPIRY_OPTIONS" :key="o.seconds" :value="o.seconds">{{ o.label }}</option>
        </select>
        <button class="rm-btn rm-btn-primary" type="submit" :disabled="busy">创建链接</button>
      </form>
      <p class="rm-share-note">分享页只读，显示笔记的当前内容及其 .assets 中的图片；拿到链接的人都能访问。</p>
      <p v-if="shares && !shares.length" class="rm-tree-empty">{{ path ? '还没有分享链接' : '还没有分享任何笔记' }}</p>
      <ul v-else class="rm-trash-list">
        <li v-for="s in shares ?? []" :key="s.token">
          <Icon name="link" />
          <div class="rm-trash-info">
            <span v-if="!path" class="rm-trash-path">{{ s.path.replace(/\.md$/, '') }}</span>
            <span class="rm-share-link" :class="{ 'rm-trash-path': path }">{{ linkOf(s) }}</span>
            <span class="rm-trash-time">
              {{ fmt.format(s.createdAt) }} 创建
              <template v-if="s.hasPassword"> · 有密码</template>
              <template v-if="expired(s)"> · <span class="rm-share-bad">已过期</span></template>
              <template v-else-if="s.expiresAt"> · {{ fmt.format(s.expiresAt) }} 到期</template>
              <template v-if="!s.exists"> · <span class="rm-share-bad">笔记不存在</span></template>
            </span>
          </div>
          <button class="rm-btn" @click="copy(s)">复制链接</button>
          <button class="rm-btn rm-btn-danger" @click="revoke(s)">撤销</button>
        </li>
      </ul>
    </div>
  </div>
</template>
