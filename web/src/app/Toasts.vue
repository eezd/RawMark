<script setup lang="ts">
import { dismissToast, ws, type Toast } from './workspace'

function act(t: Toast) {
  t.action?.run()
  dismissToast(t.id)
}
</script>

<template>
  <div class="rm-toasts" aria-live="polite">
    <div v-for="t in ws.toasts" :key="t.id" class="rm-toast">
      <span>{{ t.text }}</span>
      <button v-if="t.action" class="rm-toast-action" @click="act(t)">{{ t.action.label }}</button>
    </div>
  </div>
</template>
