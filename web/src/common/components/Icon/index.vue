<script setup lang="ts">
import type { IconName } from '../../utils/icons'
import { iconPaths } from '../../utils/icons'

export type { IconName } from '../../utils/icons'
defineProps<{ name: IconName, size?: number }>()
</script>

<template>
  <svg
    :width="size"
    :height="size"
    :class="{ 'rm-icon': size === undefined }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="iconPaths[name]" />
  </svg>
</template>
