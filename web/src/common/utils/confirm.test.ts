// @vitest-environment happy-dom
import { ElMessageBox } from 'element-plus'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { confirmAction } from './confirm'

const user = useUserStore(pinia)
beforeEach(() => user.setToken('rms_old'))
afterEach(() => {
  vi.restoreAllMocks(); user.setToken('')
})
it.each(['cancel', 'close'])('用户 %s 时明确取消，不执行危险操作', async (action) => {
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(action)
  expect(await confirmAction('删除？')).toBe(false)
})
it('确认期间切换身份后，旧操作不使用新身份执行', async () => {
  let finish!: (action: Awaited<ReturnType<typeof ElMessageBox.confirm>>) => void
  vi.spyOn(ElMessageBox, 'confirm').mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const pending = confirmAction('删除？')
  user.setToken('rms_new'); finish('confirm' as Awaited<ReturnType<typeof ElMessageBox.confirm>>)
  expect(await pending).toBe(false)
})
it('非取消错误保留原因并拒绝，不能吞成用户取消', async () => {
  const cause = new Error('确认框加载失败')
  vi.spyOn(ElMessageBox, 'confirm').mockRejectedValue(cause)
  await expect(confirmAction('删除？')).rejects.toBe(cause)
})
