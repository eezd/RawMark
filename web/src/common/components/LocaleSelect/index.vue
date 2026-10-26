<script setup lang="ts">
import type { Locale } from '@@/i18n/runtime'
import { locale, t as translate } from '@@/i18n/runtime'

defineEmits<{ change: [value: Locale] }>()
</script>

<template>
  <el-select :model-value="locale" :aria-label="translate('common.language')" style="width: 160px" @change="$emit('change', $event)">
    <el-option label="English" value="en" />
    <el-option label="简体中文" value="zh-CN" />
  </el-select>
</template>
