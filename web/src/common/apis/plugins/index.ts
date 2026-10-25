import type { InstalledPlugin } from './type'
import { requestJSON } from '@/http/axios'

export const pluginsApi = {
  plugins: async () => (await requestJSON<{ plugins: InstalledPlugin[] }>('GET', '/plugins', { errorOwner: 'caller' })).plugins,
  installPlugin: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return requestJSON<InstalledPlugin>('POST', '/plugins', { errorOwner: 'caller', body })
  },
  togglePlugin: (id: string, enabled: boolean) => requestJSON<InstalledPlugin>('PATCH', `/plugins/${encodeURIComponent(id)}`, { errorOwner: 'caller', json: { enabled } }),
  uninstallPlugin: (id: string) => requestJSON('DELETE', `/plugins/${encodeURIComponent(id)}`, { errorOwner: 'caller' }),
  pluginData: (id: string) => requestJSON<{ data: unknown }>('GET', `/plugins/${encodeURIComponent(id)}/data`, { errorOwner: 'caller' }),
  savePluginData: (id: string, data: unknown) => requestJSON('PUT', `/plugins/${encodeURIComponent(id)}/data`, { errorOwner: 'caller', json: { data } }),
}
