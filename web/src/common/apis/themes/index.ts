import type * as Themes from './type'
import { request } from '@/http/axios'

/** 读取可选主题。 */
export function getThemesApi() {
  return request<Themes.ThemesResponseData>({
    url: 'themes',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 读取主题与样式。 */
export function getThemeApi(id: string) {
  return request<Themes.ThemeResponseData>({
    url: `themes/${encodeURIComponent(id)}`,
    method: 'get',
    errorOwner: 'caller',
  })
}
