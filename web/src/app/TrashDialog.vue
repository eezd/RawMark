<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, type TrashItem } from './api'
import Icon from './Icon.vue'
import { restore, toast } from './workspace'

const emit = defineEmits<{ close: [] }>()
const items = ref<TrashItem[] | null>(null)

async function load() {
  try {
    items.value = await api.trash()
  } catch {
    toast('读取回收站失败')
    emit('close')
  }
}

async function doRestore(item: TrashItem) {
  items.value = items.value!.filter((i) => i.id !== item.id)
  await restore(item.id)
}

async function purge(item: TrashItem) {
  if (!confirm(`彻底删除“${item.path}”？此操作无法撤销。`)) return
  items.value = items.value!.filter((i) => i.id !== item.id)
  try {
    await api.purge(item.id)
  } catch {
    toast('删除失败')
    void load()
  }
}

const fmt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
onMounted(load)
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="emit('close')">
    <div class="rm-dialog" role="dialog" aria-label="回收站">
      <div class="rm-dialog-head">
        <h2>回收站</h2>
        <button class="rm-icon-btn" title="关闭" @click="emit('close')"><Icon name="close" /></button>
      </div>
      <p v-if="items && !items.length" class="rm-tree-empty">回收站是空的</p>
      <ul v-else class="rm-trash-list">
        <li v-for="item in items ?? []" :key="item.id">
          <Icon :name="item.dir ? 'folder' : 'note'" />
          <div class="rm-trash-info">
            <span class="rm-trash-path">{{ item.path.replace(/\.md(\.enc)?$/, '') }}</span>
            <span class="rm-trash-time">{{ fmt.format(item.deletedAt) }}</span>
          </div>
          <button class="rm-btn" @click="doRestore(item)">恢复</button>
          <button class="rm-btn rm-btn-danger" @click="purge(item)">彻底删除</button>
        </li>
      </ul>
    </div>
  </div>
</template>
