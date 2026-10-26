<script setup lang="ts">
import { t as translate } from '@@/i18n/runtime'

import { computed } from 'vue'
import { activeTab, keepLocalVersion, retrySave, useServerVersion } from '../workspace'

const tab = computed(activeTab)
</script>

<template>
  <div v-if="tab?.status === 'conflict'" class="rm-banner warn">
    <span>{{ translate('workspace.this_note_was_changed_elsewhere_641d37') }}</span>
    <el-button class="rm-btn" @click="useServerVersion(tab.path)">
      {{ translate('workspace.load_server_version_b24209') }}
    </el-button>
    <el-button class="rm-btn" @click="keepLocalVersion(tab.path)">
      {{ translate('workspace.keep_my_changes_cf78a9') }}
    </el-button>
  </div>
  <div v-else-if="tab?.status === 'deleted'" class="rm-banner warn">
    <span>{{ translate('workspace.this_note_was_deleted_or_07470b') }}</span>
    <el-button class="rm-btn" @click="keepLocalVersion(tab.path)">
      {{ translate('workspace.save_again_e18806') }}
    </el-button>
  </div>
  <div v-else-if="tab?.saveError" class="rm-banner error">
    <span>{{ tab.saveError }}</span>
    <el-button class="rm-btn" @click="retrySave(tab.path)">
      {{ translate('workspace.retry_now_77c30e') }}
    </el-button>
  </div>
</template>
