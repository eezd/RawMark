<script setup lang="ts">
import { computed } from 'vue'
import { activeTab, keepLocalVersion, retrySave, useServerVersion } from '../workspace'

const tab = computed(activeTab)
</script>

<template>
  <div v-if="tab?.status === 'conflict'" class="rm-banner warn">
    <span>这篇笔记已在其他地方被修改，与你的修改冲突。</span>
    <el-button class="rm-btn" @click="useServerVersion(tab.path)">
      载入服务器版本
    </el-button>
    <el-button class="rm-btn" @click="keepLocalVersion(tab.path)">
      保留我的修改
    </el-button>
  </div>
  <div v-else-if="tab?.status === 'deleted'" class="rm-banner warn">
    <span>这篇笔记已在其他地方被删除或移动。</span>
    <el-button class="rm-btn" @click="keepLocalVersion(tab.path)">
      重新保存
    </el-button>
  </div>
  <div v-else-if="tab?.saveError" class="rm-banner error">
    <span>{{ tab.saveError }}</span>
    <el-button class="rm-btn" @click="retrySave(tab.path)">
      立即重试
    </el-button>
  </div>
</template>
