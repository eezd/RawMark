<script setup lang="ts">
import { computed } from 'vue'
import { metadata } from './metadata'
import { openReference, ws } from './workspace'
const incoming = computed(() => metadata.notes.flatMap(note => note.links.filter(link => link.target === ws.active).map(link => ({ ...link, path: note.path, title: note.title }))))
const note = computed(() => metadata.notes.find(note => note.path === ws.active))
</script>
<template>
  <section class="rm-note-relations" aria-label="笔记关联">
    <div v-if="note?.tags.length" class="rm-note-tags"><span v-for="tag in note.tags" :key="tag">#{{ tag }}</span></div>
    <h3>反向链接 <small>{{ incoming.length }}</small></h3>
    <p v-if="metadata.error" role="alert">{{ metadata.error }}</p>
    <p v-else-if="!metadata.ready">关系索引准备中…</p>
    <button v-for="link in incoming" :key="link.path + ':' + link.line" @click="openReference(link.path, link.line)"><strong>{{ link.title }}</strong><small>{{ link.path }} · 第 {{ link.line }} 行</small></button>
    <p v-if="metadata.ready && !incoming.length">暂无其他笔记链接到这里</p>
    <p v-for="warning in note?.warnings" :key="warning" role="alert">{{ warning }}</p>
  </section>
</template>
<style scoped>
.rm-note-relations { padding: 20px 16px; border-top: 1px solid var(--rm-divider); overflow: auto; max-height: 40%; }
h3 { font-size: var(--rm-ui-font-size); margin: 0 0 12px; } h3 small { color: var(--rm-text-muted); margin-left: 6px; }
p { font-size: var(--rm-ui-font-caption); color: var(--rm-text-muted); line-height: 1.8; }
button { display: flex; flex-direction: column; gap: 5px; width: 100%; text-align: left; padding: 9px; border: 0; border-radius: 8px; background: none; cursor: pointer; }
button:hover { background: var(--rm-hover); } strong { font-size: var(--rm-ui-font-size); font-weight: 500; } small { font-size: var(--rm-ui-font-caption); color: var(--rm-text-muted); overflow-wrap: anywhere; }
.rm-note-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 18px; } .rm-note-tags span { font-size: var(--rm-ui-font-caption); padding: 4px 7px; border-radius: 5px; background: var(--rm-selection); color: var(--rm-accent); }
</style>
