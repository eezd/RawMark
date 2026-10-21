<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import Icon from './Icon.vue'
import { basename, imageInFolder } from './paths'
import { imageUrl, ws } from './workspace'

const props = defineProps<{ dir: string }>()
const dialog = ref<HTMLElement>()
const query = ref('')
const images = computed(() => ws.entries.filter((entry) => !entry.dir && imageInFolder(entry.path, props.dir) && entry.path.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())).sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true })))
const exists = computed(() => props.dir === '' || ws.entries.some((entry) => entry.dir && entry.path === props.dir))
onMounted(() => dialog.value?.focus())
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="ws.images = null" @keydown.esc.stop.prevent="ws.images = null">
    <section ref="dialog" class="rm-dialog rm-gallery" tabindex="-1" role="dialog" aria-label="文件夹图片管理">
      <div class="rm-dialog-head">
        <h2>{{ dir ? basename(dir) : '根目录' }} · 图片管理</h2>
        <button class="rm-icon-btn" title="关闭" @click="ws.images = null"><Icon name="close" /></button>
      </div>
      <div class="rm-gallery-tools"><input v-model="query" type="search" aria-label="搜索图片" placeholder="按名称或附件目录筛选…" /><span>{{ images.length }} 张图片</span></div>
      <p class="rm-share-note">展示当前目录及直属 assets、*.assets 中的图片，不包含下级普通文件夹。点击图片可预览、改名、移动、替换或删除。</p>
      <p v-if="!exists" class="rm-tree-empty" role="alert">文件夹已不存在</p>
      <div v-else-if="images.length" class="rm-gallery-grid">
        <button v-for="image in images" :key="image.path" class="rm-gallery-item" :title="image.path" @click="ws.image = image.path">
          <img :src="imageUrl(image.path)" :alt="basename(image.path)" loading="lazy" />
          <strong>{{ basename(image.path) }}</strong>
          <span>{{ dir ? image.path.slice(dir.length + 1) : image.path }}</span>
          <span>{{ (image.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) }} KB</span>
        </button>
      </div>
      <p v-else class="rm-tree-empty">{{ query ? '没有符合筛选条件的图片' : '此目录没有图片' }}</p>
    </section>
  </div>
</template>

<style scoped>
.rm-gallery { width: min(960px, calc(100vw - 24px)); max-width: 960px; }
.rm-gallery-tools { display: flex; align-items: center; gap: 12px; padding: 0 20px; font-size: 13px; color: var(--rm-text-muted); }
.rm-gallery-tools input { flex: 1; min-width: 0; padding: 8px; border-radius: 6px; border: 1px solid var(--rm-divider); color: var(--rm-text); background: var(--rm-bg); }
.rm-gallery-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; padding: 12px 20px 20px; overflow-y: auto; }
.rm-gallery-item { display: flex; flex-direction: column; align-items: stretch; text-align: left; gap: 5px; padding: 8px; border: 1px solid var(--rm-divider); border-radius: 8px; background: var(--rm-bg); color: var(--rm-text); cursor: pointer; min-width: 0; }
.rm-gallery-item:hover { border-color: var(--rm-accent); background: var(--rm-hover); }
.rm-gallery-item img { width: 100%; height: 110px; object-fit: contain; border-radius: 4px; }
.rm-gallery-item strong, .rm-gallery-item span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
.rm-gallery-item span { color: var(--rm-text-muted); }
</style>
