<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { metadata, refreshMetadata } from './metadata'
import { openNote, openReference, ws } from './workspace'
const query = ref('')
const tag = ref('')
const local = ref(false)
const camera = ref({ x: -420, y: -290, width: 840 })
const tags = computed(() => {
  const counts = new Map<string, number>()
  for (const note of metadata.notes) for (const name of note.tags) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
})
const visibleNotes = computed(() => {
  const nearby = new Set([ws.active])
  for (const note of metadata.notes) for (const link of note.links) if (note.path === ws.active || link.target === ws.active) { nearby.add(note.path); nearby.add(link.target) }
  return metadata.notes.filter(note => (!local.value || nearby.has(note.path)) && (!tag.value || note.tags.includes(tag.value)) && `${note.path} ${note.title}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()))
})
const graph = computed(() => {
  const notes = [...visibleNotes.value].sort((a,b) => a.path.localeCompare(b.path))
  const paths = new Set(notes.map(note => note.path))
  const seen = new Set<string>()
  const edges = notes.flatMap(note => note.links.filter(link => {
    const key = note.path + '\0' + link.target
    if (seen.has(key) || !paths.has(link.target)) return false
    seen.add(key); return true
  }).map(link => ({ from: note.path, to: link.target })))
  const nodes = notes.map((note, i) => {
    const center = local.value && note.path === ws.active
    const angle = i * Math.PI * 2 / Math.min(notes.length, 28)
    const radius = notes.length === 1 || center ? 0 : 145 + Math.floor(i / 28) * 90
    return { ...note, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, degree: edges.filter(edge => edge.from === note.path || edge.to === note.path).length }
  })
  const byPath = new Map(nodes.map(node => [node.path, node]))
  return { nodes, edges: edges.map(edge => ({ from: byPath.get(edge.from)!, to: byPath.get(edge.to)! })) }
})
const missing = computed(() => {
  const paths = new Set(metadata.notes.map(note => note.path))
  return visibleNotes.value.flatMap(note => note.links.filter(link => !paths.has(link.target)).map(link => ({ ...link, path: note.path })))
})
function zoom(factor: number) { const old = camera.value; const width = Math.max(180, Math.min(5000, old.width * factor)); camera.value = { x: old.x + (old.width - width) / 2, y: old.y + (old.width - width) * .345, width } }
let drag: { x: number; y: number; left: number; top: number } | undefined
function start(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest('[data-note]')) return
  const svg = event.currentTarget as SVGSVGElement
  svg.setPointerCapture(event.pointerId)
  drag = { x: event.clientX, y: event.clientY, left: camera.value.x, top: camera.value.y }
}
function pan(event: PointerEvent) { if (!drag) return; const scale = camera.value.width / (event.currentTarget as SVGSVGElement).getBoundingClientRect().width; camera.value.x = drag.left - (event.clientX - drag.x) * scale; camera.value.y = drag.top - (event.clientY - drag.y) * scale }
watch(() => ws.view, () => { query.value = ''; tag.value = '' })
</script>
<template>
  <section class="rm-knowledge-panel">
    <header class="rm-knowledge-heading"><div><span class="rm-eyebrow">KNOWLEDGE CONNECTIONS</span><h1>{{ ws.view === 'graph' ? '让知识自然连接' : '标签索引' }}</h1><p>{{ metadata.notes.length }} 篇笔记，以标准 Markdown 链接与标签连接你的想法。</p></div><button class="rm-btn" @click="ws.view = 'notes'">返回笔记</button></header>
    <div class="rm-knowledge-tools"><label><Icon name="search" /><input v-model="query" type="search" placeholder="搜索笔记…" aria-label="搜索笔记" /></label><select v-model="tag" aria-label="筛选标签"><option value="">全部标签</option><option v-for="[name, count] in tags" :key="name" :value="name">#{{ name }} · {{ count }}</option></select><label v-if="ws.view === 'graph'"><input v-model="local" type="checkbox" :disabled="!ws.active" />仅当前笔记关联</label></div>
    <p v-if="metadata.error" role="alert">{{ metadata.error }} <button class="rm-btn" @click="refreshMetadata">重试</button></p>
    <p v-else-if="!metadata.ready" class="rm-tree-empty">关系索引准备中…</p>
    <template v-else-if="ws.view === 'graph'">
      <div class="rm-graph-canvas">
        <svg :viewBox="`${camera.x} ${camera.y} ${camera.width} ${camera.width * .69}`" role="img" aria-label="笔记关系图谱，可点击节点打开笔记" @pointerdown="start" @pointermove="pan" @pointerup="drag = undefined" @pointercancel="drag = undefined" @wheel.prevent="zoom($event.deltaY > 0 ? 1.12 : .89)">
          <line v-for="edge in graph.edges" :key="edge.from.path + '\0' + edge.to.path" :x1="edge.from.x" :y1="edge.from.y" :x2="edge.to.x" :y2="edge.to.y" />
          <g v-for="node in graph.nodes" :key="node.path" :transform="`translate(${node.x} ${node.y})`" data-note tabindex="0" role="button" :aria-label="node.title" :class="{ current: node.path === ws.active }" @click="openNote(node.path)" @keydown.enter.prevent="openNote(node.path)" @keydown.space.prevent="openNote(node.path)"><title>{{ node.path }}</title><circle :r="Math.min(13, 5 + node.degree * 1.5)" /><text y="27" text-anchor="middle">{{ node.title.length > 16 ? node.title.slice(0,16) + '…' : node.title }}</text></g>
        </svg>
        <p v-if="!graph.nodes.length" class="rm-graph-empty">没有符合条件的笔记</p>
        <div class="rm-graph-controls"><span>{{ graph.nodes.length }} 节点 · {{ graph.edges.length }} 关系</span><button class="rm-icon-btn" title="放大" @click="zoom(.8)">+</button><button class="rm-icon-btn" title="缩小" @click="zoom(1.25)">−</button><button class="rm-icon-btn" title="重置视图" @click="camera = { x: -420, y: -290, width: 840 }"><Icon name="expand" /></button></div>
      </div>
      <details v-if="missing.length" class="rm-missing-links"><summary>{{ missing.length }} 个链接目标尚不存在</summary><button v-for="link in missing" :key="link.path + link.line + link.target" @click="openReference(link.path, link.line)">{{ link.path }} → {{ link.target }} · 第 {{ link.line }} 行</button></details>
    </template>
    <template v-else>
      <div class="rm-tags-cloud"><button :class="{ on: !tag }" @click="tag = ''">全部</button><button v-for="[name, count] in tags" :key="name" :class="{ on: tag === name }" @click="tag = name">#{{ name }} <small>{{ count }}</small></button></div>
      <div class="rm-tag-results"><button v-for="note in visibleNotes" :key="note.path" @click="openNote(note.path)"><Icon name="note" /><div><strong>{{ note.title }}</strong><small>{{ note.path }}</small></div><span>{{ note.tags.map(tag => '#' + tag).join('  ') }}</span></button><p v-if="!visibleNotes.length">没有符合条件的笔记</p></div>
    </template>
  </section>
</template>
<style scoped>
.rm-knowledge-panel { flex: 1; overflow: auto; padding: 36px 40px; }
.rm-knowledge-heading { display: flex; justify-content: space-between; align-items: center; gap: 20px; } .rm-eyebrow { font-size: var(--rm-ui-font-caption); letter-spacing: .15em; color: var(--rm-accent); } h1 { font-family: var(--rm-font-heading); font-size: var(--rm-ui-font-title); font-weight: 600; margin: 12px 0; } p { font-size: var(--rm-ui-font-small); color: var(--rm-text-muted); }
.rm-knowledge-tools { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin: 28px 0 20px; } label { display: flex; align-items: center; gap: 8px; font-size: var(--rm-ui-font-size); } input[type=search], select { border: 1px solid var(--rm-divider); padding: 10px 12px; border-radius: 8px; color: var(--rm-text); background: var(--rm-active); font: inherit; font-size: var(--rm-ui-font-size); }
.rm-graph-canvas { position: relative; border: 1px solid var(--rm-divider); border-radius: 16px; background: radial-gradient(var(--rm-divider) 1px, transparent 1px) 0 0/20px 20px; overflow: hidden; } .rm-graph-canvas > svg { width: 100%; height: min(55vh,600px); display: block; touch-action: none; cursor: grab; } line { stroke: var(--rm-divider); stroke-width: 1.5; } circle { fill: var(--rm-accent); opacity: .6; } .current circle { opacity: 1; stroke: var(--rm-selection); stroke-width: 10px; } g { cursor: pointer; } g:hover circle, g:focus circle { opacity: 1; } text { fill: var(--rm-text-muted); font-family: var(--rm-font-text); font-size: var(--rm-ui-font-caption); } .rm-graph-controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px; background: var(--rm-active); } .rm-graph-controls span { margin-right: auto; font-size: var(--rm-ui-font-caption); color: var(--rm-text-muted); } .rm-graph-empty { position: absolute; inset: 40% 0 auto; text-align: center; pointer-events: none; }
.rm-missing-links { margin-top: 20px; font-size: var(--rm-ui-font-small); color: var(--rm-text-muted); } .rm-missing-links button { display: block; padding: 8px; background: none; border: 0; cursor: pointer; text-align: left; }
.rm-tags-cloud { display: flex; flex-wrap: wrap; gap: 10px; margin: 24px 0; } .rm-tags-cloud button { padding: 8px 12px; border: 1px solid var(--rm-divider); border-radius: 7px; background: var(--rm-active); font-size: var(--rm-ui-font-size); cursor: pointer; } .rm-tags-cloud .on { background: var(--rm-selection); color: var(--rm-accent); } .rm-tag-results > button { display: flex; align-items: center; gap: 16px; width: 100%; padding: 18px 12px; border: 0; border-bottom: 1px solid var(--rm-divider); text-align: left; background: none; cursor: pointer; } strong { font-size: var(--rm-ui-font-size); font-weight: 500; } small { display: block; margin-top: 5px; font-size: var(--rm-ui-font-caption); color: var(--rm-text-muted); } .rm-tag-results span { margin-left: auto; font-size: var(--rm-ui-font-caption); color: var(--rm-accent); } .rm-tag-results > button:hover { background: var(--rm-hover); }
@media(max-width:767px) { .rm-knowledge-panel { padding: 24px 16px; } h1 { font-size: var(--rm-ui-font-heading); } .rm-knowledge-heading { align-items: flex-start; } .rm-knowledge-heading .rm-btn { font-size: var(--rm-ui-font-size); } .rm-knowledge-tools input[type=search] { width: 140px; } .rm-tag-results span { display: none; } }
@media(max-width:767px), (pointer:coarse) { input[type=search], select { font-size: max(16px, var(--rm-ui-font-size)); } }
</style>
