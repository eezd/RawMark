import { localDate, renderTemplate } from '../markdown/template'
import { api } from './api'
import { joinPath } from './paths'
import { settings } from './settings'
import { createNoteAt, openNote, toast, ws } from './workspace'

export async function createFromTemplate(path: string, template: string) {
  if (ws.entries.some(entry => entry.path === path)) { toast('目标笔记已存在'); return false }
  const content = template ? renderTemplate((await api.readFile(template)).content, template, path) : ''
  return createNoteAt(path, content)
}

export async function openDailyNote() {
  const path = joinPath(settings.dailyFolder, localDate() + '.md')
  if (ws.entries.some(entry => !entry.dir && entry.path === path)) { await openNote(path); return }
  try { await createFromTemplate(path, settings.dailyTemplate) }
  catch (error) { toast('创建日记失败：' + (error instanceof Error ? error.message : '网络错误')) }
}
