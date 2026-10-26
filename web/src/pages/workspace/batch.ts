import { exportFilesApi } from '@@/apis/files'
import { t as translate } from '@@/i18n/runtime'

import { confirmAction } from '@@/utils/confirm'
import { toast } from '@@/utils/notifications'
import { basename, joinPath } from '@@/utils/paths'

import { isCancel } from 'axios'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { minimalPaths } from './selection'
import { flush, move, refreshTree, remove, ws } from './workspace'

export async function batchFiles(action: 'move' | 'delete', paths: string[], destination = '') {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  const subjects = minimalPaths(paths)
  if (action === 'delete' && !await confirmAction(translate('workspace.move_the_selected_items_to_3d5e79', { p0: subjects.length }))) return
  const failures: string[] = []
  let succeeded = 0
  for (const path of subjects) {
    try {
      user.assertSession(version)
      const result = action === 'move' ? await move(path, joinPath(destination, basename(path)), 'caller') : await remove(path, 'caller')
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
    toast(translate('workspace.could_not_refresh_the_file_b5f68b', { p0: String(cause) }))
  }
  toast(translate('workspace.finished_succeeded_failed_dbc164', { p0: action === 'move' ? translate('common.move') : translate('common.delete_2f9daa'), p1: succeeded, p2: failures.length, p3: failures.length ? `；${failures.join('；')}` : '' }))
  return failures.length === 0
}

export async function exportFiles(paths: string[]) {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  const subjects = minimalPaths(paths)
  const tabs = ws.tabs.filter(tab => subjects.some(path => tab.path === path || tab.path.startsWith(`${path}/`)))
  try {
    await Promise.all(tabs.map(tab => flush(tab.path)))
    user.assertSession(version)
    if (tabs.some(tab => tab.dirty || tab.status !== 'ready')) throw new Error(translate('workspace.save_your_notes_and_resolve_377e42'))
    const response = await exportFilesApi({ paths: subjects })
    const blob = response.data
    user.assertSession(version)
    const disposition = String(response.headers.get('content-disposition') ?? '')
    const encoded = /filename\*=utf-8''([^;]+)/i.exec(disposition)?.[1]
    const plain = /filename="([^"]+)"|filename=([^;]+)/i.exec(disposition)
    const filename = encoded ? decodeURIComponent(encoded) : plain?.[1] ?? plain?.[2] ?? translate('workspace.export_zip_9cdf3e')
    const url = URL.createObjectURL(blob)
    const link = Object.assign(document.createElement('a'), { href: url, download: filename })
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (cause) {
    if (isCancel(cause)) return
    toast(translate('workspace.export_failed_a53238', { p0: cause instanceof Error ? cause.message : String(cause) }))
  }
}
