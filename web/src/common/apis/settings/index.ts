import type * as Settings from './type'
import { request } from '@/http/axios'

/** 读取设置。 */
export function getSettingsApi() {
  return request<Settings.SettingsResponseData>({
    url: 'settings',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 更新设置。 */
export function patchSettingsApi(data: Settings.SettingsData) {
  return request<Settings.SettingsResponseData>({
    url: 'settings',
    method: 'patch',
    data,
    errorOwner: 'caller',
  })
}
