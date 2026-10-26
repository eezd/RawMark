<script setup lang="ts">
import Icon from '@@/components/Icon/index.vue'

import { t as translate } from '@@/i18n/runtime'
import { runCommand } from '@@/utils/commands'
import { toggleSourceMode, ws } from '../workspace'
</script>

<template>
  <section v-if="ws.active" class="rm-editor-chrome" :aria-label="translate('workspace.note_actions_afcc30')">
    <button class="rm-icon-btn" :title="translate('workspace.live_preview_195a67')" :aria-label="translate('workspace.live_preview_195a67')" :aria-pressed="!ws.sourceMode" @mousedown.prevent @click="ws.sourceMode && toggleSourceMode()">
      <Icon name="eye" />
    </button>
    <button class="rm-icon-btn" :title="translate('workspace.source_mode_11b7fd')" :aria-label="translate('workspace.source_mode_11b7fd')" :aria-pressed="ws.sourceMode" @mousedown.prevent @click="!ws.sourceMode && toggleSourceMode()">
      <Icon name="source" />
    </button>
    <button class="rm-icon-btn" :title="translate('workspace.show_hide_outline_c41996')" :aria-label="translate('workspace.show_hide_outline_c41996')" :aria-pressed="ws.outlineOpen" @click="ws.outlineOpen = !ws.outlineOpen">
      <Icon name="outline" />
    </button>
    <button class="rm-icon-btn" :title="translate('workspace.focus_mode_b35534')" :aria-label="translate('workspace.focus_mode_b35534')" :aria-pressed="ws.focusMode" @click="runCommand('view.focus')">
      <Icon name="expand" />
    </button>
  </section>
</template>
