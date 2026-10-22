<script setup lang="ts">
import Icon from './Icon.vue'
import { createNote, ws } from './workspace'
</script>

<template>
  <header class="rm-global-header">
    <button class="rm-wordmark" @click="ws.settings = null; ws.images = null"><Icon name="edit" :size="22" /><span>RawMark</span></button>
    <span class="rm-edition">个人知识库</span>
    <nav class="rm-primary-nav" aria-label="工作区"><button class="on"><Icon name="folder" />笔记</button></nav>
    <button class="rm-global-search" @click="ws.switcher = ''"><Icon name="search" /><span>全局检索知识库</span><kbd>⌘ / Ctrl P</kbd></button>
    <div class="rm-header-actions">
      <button class="rm-icon-btn" title="设置" @click="ws.settings = 'index'"><Icon name="settings" /></button>
      <button class="rm-btn" :disabled="!ws.active" @click="ws.sharing = ws.active"><Icon name="share" />分享</button>
      <button class="rm-btn rm-btn-primary" @click="createNote('')"><Icon name="plus" />新建笔记</button>
      <span class="rm-avatar" aria-label="个人工作区">RM</span>
    </div>
  </header>
</template>
