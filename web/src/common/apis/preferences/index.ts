import type { CustomFont, Theme } from './type'
import { requestJSON } from '@/http/axios'

export const preferencesApi = {
  settings: () => requestJSON<Record<string, unknown>>('GET', '/settings', { errorOwner: 'caller' }),
  fonts: async () => (await requestJSON<{ fonts: CustomFont[] }>('GET', '/fonts', { errorOwner: 'caller' })).fonts,
  importFont: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return requestJSON<CustomFont>('POST', '/fonts', { errorOwner: 'caller', body })
  },
  deleteFont: (id: string) => requestJSON('DELETE', `/fonts/${encodeURIComponent(id)}`, { errorOwner: 'caller' }),
  themes: async () => (await requestJSON<{ themes: Theme[] }>('GET', '/themes', { errorOwner: 'caller' })).themes,
  theme: (id: string) => requestJSON<Theme & { css: string }>('GET', `/themes/${encodeURIComponent(id)}`, { errorOwner: 'caller' }),
  patchSettings: (patch: Record<string, unknown>) => requestJSON<Record<string, unknown>>('PATCH', '/settings', { errorOwner: 'caller', json: patch }),
}
