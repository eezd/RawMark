<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { basename } from './paths'
import SharePanel from './SharePanel.vue'

const props = defineProps<{ path: string | string[] }>()
const title = computed(() => typeof props.path === 'string' ? basename(props.path) : `${props.path.length} 项内容`)
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="rm-dialog-backdrop" @click.self="emit('close')">
    <div class="rm-dialog rm-share-dialog" role="dialog" :aria-label="`分享“${title}”`">
      <div class="rm-dialog-head">
        <h2>分享“{{ title }}”</h2>
        <button class="rm-icon-btn" title="关闭" @click="emit('close')"><Icon name="close" /></button>
      </div>
      <SharePanel :path="path" />
    </div>
  </div>
</template>
