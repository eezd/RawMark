import { t as translate } from '@@/i18n/runtime'
import { ElMessageBox } from 'element-plus'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

/** 确认等待期间换会话时，旧操作视为取消。 */
export async function confirmAction(message: string, title = translate('common.confirm_action_f8347f')): Promise<boolean> {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  try {
    await ElMessageBox.confirm(message, title, { get confirmButtonText() {
      return translate('common.confirm_fac2a6')
    }, get cancelButtonText() {
      return translate('common.cancel_2cd0f3')
    }, type: 'warning', distinguishCancelAndClose: true })
    return version === user.getSessionVersion()
  } catch (cause) {
    if (cause === 'cancel' || cause === 'close') return false
    throw cause
  }
}
