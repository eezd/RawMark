import type { Settings } from '@/pinia/stores/settings'
import { t as translate } from '@@/i18n/runtime'
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
      toast(cause instanceof Error ? cause.message : translate('settings.could_not_save_settings_17b49d'))
      if (cause instanceof SettingsAppearanceError) return true
      try {
        await store.loadSettings()
      } catch (reload) {
        if (!isCancel(reload)) toast(translate('settings.could_not_reload_settings_744b6a', { p0: String(reload) }))
      }
      return false
    }
  }
}
