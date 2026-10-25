<script setup lang="ts">
import type { Toast } from '@@/utils/notifications'
import { dismissToast, toasts } from '@@/utils/notifications'

function act(t: Toast) {
  t.action?.run()
  dismissToast(t.id)
}
</script>

<template>
  <div class="rm-toasts" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="rm-toast">
      <span>{{ t.text }}</span>
      <button v-if="t.action" class="rm-toast-action" @click="act(t)">
        {{ t.action.label }}
      </button>
    </div>
  </div>
</template>
