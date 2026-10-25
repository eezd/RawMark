import { toast } from '@@/utils/notifications'
import { isCancel } from 'axios'
import { workspaceApi } from '@/pages/workspace/apis'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { basename, joinPath } from '../../common/utils/paths'
import { minimalPaths } from './selection'
import { flush, move, refreshTree, remove, ws } from './workspace'

export async function batchFiles(action: 'move' | 'delete', paths: string[], destination = '') {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  const subjects = minimalPaths(paths)
  if (action === 'delete' && !confirm(`将选中的 ${subjects.length} 项移入回收站？文件夹内的内容也会一起删除。`)) return
  const failures: string[] = []
  let succeeded = 0
  for (const path of subjects) {
    try {
      user.assertSession(version)
      const result = action === 'move' ? await move(path, joinPath(destination, basename(path))) : await remove(path)
      if (result.ok) succeeded++
      else failures.push(`${path}：${result.error}`)
    } catch (cause) {
      if (isCancel(cause)) return
      failures.push(`${path}：${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (version !== user.getSessionVersion()) return
  try {
    await refreshTree()
    user.assertSession(version)
  } catch (cause) {
    if (isCancel(cause)) return
    toast(`刷新目录失败：${String(cause)}`)
  }
  toast(`${action === 'move' ? '移动' : '删除'}完成：成功 ${succeeded} 项，失败 ${failures.length} 项${failures.length ? `；${failures.join('；')}` : ''}`)
}

export async function exportFiles(paths: string[]) {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  const subjects = minimalPaths(paths)
  const tabs = ws.tabs.filter(tab => subjects.some(path => tab.path === path || tab.path.startsWith(`${path}/`)))
  try {
    await Promise.all(tabs.map(tab => flush(tab.path)))
    user.assertSession(version)
    if (tabs.some(tab => tab.dirty || tab.status !== 'ready')) throw new Error('请先保存笔记并解决冲突，再导出')
    const response = await workspaceApi.exportFiles(subjects)
    const blob = await response.blob()
    user.assertSession(version)
    const disposition = response.headers.get('Content-Disposition') ?? ''
    const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition)?.[1]
    const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition)
    const filename = encoded ? decodeURIComponent(encoded) : plain?.[1] ?? plain?.[2] ?? '导出.zip'
    const url = URL.createObjectURL(blob)
    const link = Object.assign(document.createElement('a'), { href: url, download: filename })
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) {
    if (isCancel(cause)) return
    toast(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`)
  }
}
