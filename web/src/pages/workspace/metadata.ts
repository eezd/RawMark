import type { NoteMetadata } from '@/pages/workspace/apis/type'
import { isCancel } from 'axios'
import { reactive } from 'vue'
import { workspaceApi } from '@/pages/workspace/apis'

export const metadata = reactive({ notes: [] as NoteMetadata[], ready: false, error: '' })
let request = 0
export async function refreshMetadata() {
  const current = ++request
  try {
    const result = await workspaceApi.metadata()
    if (current !== request) return
    metadata.notes = result.notes
    metadata.ready = result.ready
    metadata.error = ''
  } catch (error) {
    if (isCancel(error)) return
    if (current === request) metadata.error = error instanceof Error ? error.message : '关系索引读取失败'
  }
}
