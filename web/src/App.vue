<script setup lang="ts">
import Toasts from '@@/components/Toasts/index.vue'

import { locale, t as translate } from '@@/i18n/runtime'
import en from 'element-plus/es/locale/lang/en'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import { useUserStore } from '@/pinia/stores/user'
import { navigationError, router } from '@/router'

const user = useUserStore()
function retry() {
  const { path, query, hash } = router.resolve(navigationError.value!.path)
  void router.replace({ path, query, hash, force: true }).catch(() => { /* The router error interface displays failures. */ })
}
</script>

<template>
  <el-config-provider :locale="locale === 'zh-CN' ? zhCn : en">
    <div v-if="navigationError" class="rm-splash" role="alert">
      <p>{{ navigationError.message }}</p><el-button @click="retry">
        {{ translate('common.retry_b8784c') }}
      </el-button>
    </div>
    <router-view v-else v-slot="{ Component, route }">
      <component :is="Component" v-if="route.meta.anonymous || user.isGotUserInfo" :key="route.meta.anonymous ? route.name : user.sessionVersion" />
    </router-view>
    <Toasts />
  </el-config-provider>
</template>
