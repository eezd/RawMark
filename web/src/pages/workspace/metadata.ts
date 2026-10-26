import type { NoteMetadata } from '@@/apis/metadata/type'
import { getMetadataApi } from '@@/apis/metadata'
import { isCancel } from 'axios'
import { reactive } from 'vue'

export const metadata = reactive({ notes: [] as NoteMetadata[], ready: false, error: '' })
let request = 0
export async function refreshMetadata() {
  const current = ++request
  try {
    const result = (await getMetadataApi()).data
    if (current !== request) return
    metadata.notes = result.notes
    metadata.ready = result.ready
    metadata.error = ''
  } catch (error) {
    if (isCancel(error)) return
    if (current === request) metadata.error = error instanceof Error ? error.message : '关系索引读取失败'
  }
}
