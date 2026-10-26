<script setup lang="ts">
import { t as translate } from '@@/i18n/runtime'
</script>

<template>
  <div class="error">
    <div class="error-svg">
      <slot />
    </div>
    <router-link to="/">
      <el-button type="primary">
        {{ translate('error.back_to_home_6774a7') }}
      </el-button>
    </router-link>
  </div>
</template>

<style lang="scss" scoped>
.error {
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  &-svg {
    width: 400px;
    max-width: 100%;
    margin-bottom: 50px;
  }
}
</style>
