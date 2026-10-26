<script setup lang="ts">
import Icon from '@@/components/Icon/index.vue'
import { runCommand } from '@@/utils/commands'
import { toggleSourceMode, ws } from '../workspace'
</script>

<template>
  <section v-if="ws.active" class="rm-editor-chrome" aria-label="笔记操作">
    <button class="rm-icon-btn" title="即时预览" aria-label="即时预览" :aria-pressed="!ws.sourceMode" @mousedown.prevent @click="ws.sourceMode && toggleSourceMode()">
      <Icon name="eye" />
    </button>
    <button class="rm-icon-btn" title="源码模式" aria-label="源码模式" :aria-pressed="ws.sourceMode" @mousedown.prevent @click="!ws.sourceMode && toggleSourceMode()">
      <Icon name="source" />
    </button>
    <button class="rm-icon-btn" title="显示 / 隐藏大纲" aria-label="显示 / 隐藏大纲" :aria-pressed="ws.outlineOpen" @click="ws.outlineOpen = !ws.outlineOpen">
      <Icon name="outline" />
    </button>
    <button class="rm-icon-btn" title="专注写作" aria-label="专注写作" :aria-pressed="ws.focusMode" @click="runCommand('view.focus')">
      <Icon name="expand" />
    </button>
  </section>
</template>
