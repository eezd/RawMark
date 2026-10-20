<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { mountContent } from '../plugins/mount'
import type { OwnedView } from '../plugins/registry'

const props = defineProps<{ view: OwnedView }>()
const container = ref<HTMLElement>()
let stop = () => {}
watch(() => [container.value, props.view] as const, ([el, view]) => {
  stop()
  if (el) stop = mountContent(el, view.mount, view.fail)
}, { flush: 'post', immediate: true })
onBeforeUnmount(() => stop())
</script>

<template><div ref="container" class="rm-plugin-view" /></template>
