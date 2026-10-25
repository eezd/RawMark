import type { Entry } from './type'
import { encodePath, requestJSON, requestRaw } from '@/http/axios'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

export const vaultApi = {
  tree: async () => (await requestJSON<{ entries: Entry[] }>('GET', '/tree', { errorOwner: 'caller' })).entries,
  async readFile(path: string): Promise<{ content: string, rev: string }> {
    const user = useUserStore(pinia)
    const version = user.getSessionVersion()
    const res = await requestRaw('GET', `/files/${encodePath(path)}`, { errorOwner: 'caller' })
    const content = await res.text()
    user.assertSession(version)
    return { content, rev: (res.headers.get('ETag') ?? '').replace(/"/g, '') }
  },
}
