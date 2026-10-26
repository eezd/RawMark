import type * as Settings from './type'
import { request } from '@/http/axios'

/** Read settings. */
export function getSettingsApi() {
  return request<Settings.SettingsResponseData>({
    url: 'settings',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Update settings. */
export function patchSettingsApi(data: Settings.SettingsData) {
  return request<Settings.SettingsResponseData>({
    url: 'settings',
    method: 'patch',
    data,
    errorOwner: 'caller',
  })
}
