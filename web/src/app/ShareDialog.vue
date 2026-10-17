<script setup lang="ts">
import Icon from './Icon.vue'
import { noteTitle } from './paths'
import SharePanel from './SharePanel.vue'

defineProps<{ path: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="emit('close')">
    <div class="rm-dialog rm-share-dialog" role="dialog" :aria-label="`分享“${noteTitle(path)}”`">
      <div class="rm-dialog-head">
        <h2>分享“{{ noteTitle(path) }}”</h2>
        <button class="rm-icon-btn" title="关闭" @click="emit('close')"><Icon name="close" /></button>
      </div>
      <SharePanel :path="path" />
    </div>
  </div>
</template>
