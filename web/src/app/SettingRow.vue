<script setup lang="ts">
import { computed } from 'vue'
import Icon from './Icon.vue'
import { SETTING_ITEMS, type SettingId } from './settingsCatalog'
const props = defineProps<{ id: SettingId; control?: string; resettable?: boolean }>()
defineEmits<{ reset: [] }>()
const item = computed(() => SETTING_ITEMS[props.id])
</script>

<template>
  <div :id="'rm-setting-' + id" class="rm-setting" tabindex="-1">
    <div class="rm-setting-info">
      <component :is="control ? 'label' : 'span'" :for="control" class="rm-setting-label">{{ item.title }}</component>
      <p>{{ item.description }}</p>
    </div>
    <div class="rm-setting-control">
      <slot />
      <button v-if="resettable" class="rm-icon-btn rm-setting-reset" :title="'重置' + item.title" :aria-label="'重置' + item.title" @click="$emit('reset')"><Icon name="restore" /></button>
    </div>
  </div>
</template>
