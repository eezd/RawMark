import { reactive } from 'vue'
import { api, type NoteMetadata } from './api'

export const metadata = reactive({ notes: [] as NoteMetadata[], ready: false, error: '' })
let request = 0
export async function refreshMetadata() {
  const current = ++request
  try {
    const result = await api.metadata()
    if (current !== request) return
    metadata.notes = result.notes
    metadata.ready = result.ready
    metadata.error = ''
  } catch (error) {
    if (current === request) metadata.error = error instanceof Error ? error.message : '关系索引读取失败'
  }
}
