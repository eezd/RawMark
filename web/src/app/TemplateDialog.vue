<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { settings } from './settings'
import { createFromTemplate } from './templates'
import { createNote, toast, ws } from './workspace'
const templates = computed(() => ws.entries.filter(entry => !entry.dir && entry.path.startsWith(settings.templatesFolder + '/') && entry.path.endsWith('.md')))
const selected = ref('')
const path = ref('未命名.md')
const busy = ref(false)
async function create() {
  if (!path.value.endsWith('.md') || path.value.split('/').some(part => !part || part.startsWith('.') || /[\\\0]/.test(part))) { toast('请输入有效的 Markdown 笔记路径'); return }
  busy.value = true
  try { if (await createFromTemplate(path.value, selected.value)) ws.templateOpen = false }
  catch (error) { toast('读取模板失败：' + (error instanceof Error ? error.message : '网络错误')) }
  finally { busy.value = false }
}
</script>
<template>
  <div class="rm-dialog-backdrop" @click.self="!busy && (ws.templateOpen = false)" @keydown.esc.stop="!busy && (ws.templateOpen = false)">
    <section class="rm-dialog rm-template-dialog" role="dialog" aria-label="从模板新建">
      <div class="rm-dialog-head"><h2>从模板开始</h2><button class="rm-icon-btn" title="关闭" :disabled="busy" @click="ws.templateOpen = false"><Icon name="close" /></button></div>
      <p class="rm-share-note">模板是 {{ settings.templatesFolder }}/ 下的 Markdown 文件。支持 <code v-pre>{{date}}</code>、<code v-pre>{{time}}</code> 和 <code v-pre>{{title}}</code>，图片沿用原模板资源。</p>
      <form @submit.prevent="create">
        <label>选择模板<select v-model="selected"><option value="">空白笔记</option><option v-for="template in templates" :key="template.path" :value="template.path">{{ template.path }}</option></select></label>
        <label>笔记路径<input v-model="path" aria-label="笔记路径" required /></label>
        <div class="rm-template-actions"><button class="rm-btn" type="button" :disabled="busy" @click="ws.templateOpen = false; createNote(settings.templatesFolder)">新建模板文件</button><button class="rm-btn rm-btn-primary" :disabled="busy">创建笔记</button></div>
      </form>
    </section>
  </div>
</template>
<style scoped>
.rm-template-dialog { width: min(520px, calc(100vw - 24px)); overflow-y: auto; } form { display: grid; gap: 20px; padding: 20px; } label { display: grid; gap: 9px; font-size: var(--rm-ui-font-size); } input, select { padding: 10px; border: 1px solid var(--rm-divider); border-radius: 8px; background: var(--rm-bg); color: var(--rm-text); font: inherit; } .rm-template-actions { display: flex; justify-content: space-between; gap: 12px; }
@media(max-width:767px), (pointer:coarse) { input, select { font-size: max(16px, var(--rm-ui-font-size)); } }
</style>
