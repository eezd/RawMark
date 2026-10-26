import type { Settings } from '@/pinia/stores/settings'
import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { SettingsAppearanceError, useSettingsStore } from '@/pinia/stores/settings'

export function useSettingsChange() {
  const store = useSettingsStore()
  return async (patch: Partial<Settings>): Promise<boolean> => {
    try {
      await store.updateSettings(patch)
      return true
    } catch (cause) {
      if (isCancel(cause)) return false
      toast(cause instanceof Error ? cause.message : '保存设置失败')
      if (cause instanceof SettingsAppearanceError) return true
      try {
        await store.loadSettings()
      } catch (reload) {
        if (!isCancel(reload)) toast(`重新读取设置失败：${String(reload)}`)
      }
      return false
    }
  }
}
