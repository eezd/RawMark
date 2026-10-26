<script setup lang="ts">
import { t as translate } from '@@/i18n/runtime'

import { toast } from '@@/utils/notifications'
import { online, waitingWorker } from '@@/utils/pwa'
import { ref } from 'vue'

const props = withDefaults(defineProps<{ beforeReload?: () => Promise<boolean> }>(), { beforeReload: async () => true })

const busy = ref(false)
const activated = ref(false)

async function update() {
  const worker = waitingWorker.value
  if ((!worker && !activated.value) || busy.value) return
  busy.value = true
  try {
    if (!await props.beforeReload()) {
      toast(translate('common.finish_saving_uploading_images_or_b9e96e'))
      return
    }
    if (!activated.value && worker) {
      // After the new version activates, refresh only the page that requested the update.
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          if (worker.state !== 'activated' && worker.state !== 'redundant') return
          clearTimeout(timer)
          worker.removeEventListener('statechange', finish)
          if (worker.state === 'activated') resolve()
          else reject(new Error(translate('common.could_not_activate_the_new_c0fd5b')))
        }
        const timer = setTimeout(() => {
          worker.removeEventListener('statechange', finish)
          reject(new Error(translate('common.timed_out_waiting_for_the_57775d')))
        }, 15000)
        worker.addEventListener('statechange', finish)
        worker.postMessage('ACTIVATE')
        finish()
      })
      activated.value = true
    }
    // Typing may continue during activation; confirm again before refreshing and keep the button for retrying after save.
    if (await props.beforeReload()) location.reload()
    else toast(translate('common.some_changes_or_operations_are_a5fda9'))
  } catch {
    toast(translate('common.cannot_update_right_now_please_c0de6a'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="!online || waitingWorker || activated" class="rm-app-status" role="status">
    <span v-if="!online">{{ translate('common.offline_notes_cannot_be_loaded_8ecb92') }}</span>
    <template v-else-if="waitingWorker || activated">
      <span>{{ translate('common.update_available_daedea') }}</span>
      <el-button class="rm-btn" :disabled="busy" @click="update">
        {{ busy ? translate('common.saving_6bdb44') : translate('common.save_and_refresh_d080ec') }}
      </el-button>
    </template>
  </div>
</template>
