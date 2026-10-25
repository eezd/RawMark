import type { TrashItem, TrashPurgeResult } from './type'
import { requestJSON } from '@/http/axios'

export const trashApi = {
  clearTrash: () => requestJSON<TrashPurgeResult>('DELETE', '/trash', { errorOwner: 'caller' }),
  trash: async () => (await requestJSON<{ items: TrashItem[] }>('GET', '/trash', { errorOwner: 'caller' })).items,
  restore: (id: string) => requestJSON<TrashItem>('POST', `/trash/${id}/restore`, { errorOwner: 'caller' }),
  purge: (id: string) => requestJSON('DELETE', `/trash/${id}`, { errorOwner: 'caller' }),
}
