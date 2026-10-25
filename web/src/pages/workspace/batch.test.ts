import { toasts } from '@@/utils/notifications'
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { workspaceApi } from './apis'
import { batchFiles, exportFiles } from './batch'
import { flush, remove } from './workspace'

vi.mock('./workspace', () => ({ move: vi.fn(), remove: vi.fn(), refreshTree: vi.fn().mockResolvedValue(undefined), flush: vi.fn(), ws: { tabs: [{ path: 'a.md', dirty: false, status: 'ready' }] } }))
const user = useUserStore(pinia)
beforeEach(() => {
  user.setToken('rms_old'); toasts.splice(0)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); user.setToken('')
})
it('切换会话后批量操作停止，不以新身份继续下一项', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true))
  let finish!: (value: { ok: true }) => void
  vi.mocked(remove).mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const pending = batchFiles('delete', ['a.md', 'b.md'])
  user.setToken('rms_new')
  finish({ ok: true })
  await pending
  expect(remove).toHaveBeenCalledTimes(1)
  expect(toasts).toHaveLength(0)
})
it('等待笔记保存时换会话，不再使用新身份导出旧选择', async () => {
  let finish!: () => void
  vi.mocked(flush).mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  const request = vi.spyOn(workspaceApi, 'exportFiles')
  const pending = exportFiles(['a.md'])
  user.setToken('rms_new')
  finish()
  await pending
  expect(request).not.toHaveBeenCalled()
  expect(toasts).toHaveLength(0)
})
