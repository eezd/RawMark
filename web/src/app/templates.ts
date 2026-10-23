import { localDate, renderTemplate } from '../markdown/template'
import { api } from './api'
import { joinPath } from './paths'
import { settings } from './settings'
import { createNoteAt, openNote, toast, ws } from './workspace'

export async function createFromTemplate(path: string, template: string) {
  if (ws.entries.some(entry => entry.path === path)) { toast('目标笔记已存在'); return false }
  const content = template ? renderTemplate((await api.readFile(template)).content, template, path) : ''
  const created = await createNoteAt(path, content)
  if (created) ws.sidebarOpen = false
  return created
}

let openingDaily = false
export async function openDailyNote() {
  // 模板读取也属于打开日记的过程，此时尚未加入乐观目录。
  if (openingDaily) return
  openingDaily = true
  try {
    const path = joinPath(settings.dailyFolder, localDate() + '.md')
    if (ws.entries.some(entry => !entry.dir && entry.path === path)) { await openNote(path); return }
    await createFromTemplate(path, settings.dailyTemplate)
  }
  catch (error) { toast('创建日记失败：' + (error instanceof Error ? error.message : '网络错误')) }
  finally { openingDaily = false }
}
