import { ElMessageBox } from 'element-plus'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

/** 确认等待期间换会话时，旧操作视为取消。 */
export async function confirmAction(message: string, title = '确认操作'): Promise<boolean> {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  try {
    await ElMessageBox.confirm(message, title, { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning', distinguishCancelAndClose: true })
    return version === user.getSessionVersion()
  } catch (cause) {
    if (cause === 'cancel' || cause === 'close') return false
    throw cause
  }
}
