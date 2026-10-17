<script setup lang="ts">
import Icon from './Icon.vue'
import { isEncrypted, noteTitle } from './paths'
import { closeTab, ws } from './workspace'
</script>

<template>
  <nav class="rm-tabs" role="tablist">
    <div
      v-for="tab in ws.tabs"
      :key="tab.path"
      class="rm-tab"
      :class="{ active: ws.active === tab.path }"
      role="tab"
      :aria-selected="ws.active === tab.path"
      :title="tab.path"
      @click="ws.active = tab.path"
      @auxclick.prevent="$event.button === 1 && closeTab(tab.path)"
    >
      <Icon v-if="isEncrypted(tab.path)" name="lock" :size="12" class="rm-lock-icon" />
      <span class="rm-tab-title">{{ noteTitle(tab.path) }}</span>
      <button class="rm-tab-close" :class="{ dirty: tab.dirty }" title="关闭" @click.stop="closeTab(tab.path)">
        <span class="rm-dirty-dot" />
        <Icon name="close" :size="12" />
      </button>
    </div>
  </nav>
</template>
