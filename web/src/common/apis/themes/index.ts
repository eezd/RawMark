import type * as Themes from './type'
import { request } from '@/http/axios'

/** List available themes. */
export function getThemesApi() {
  return request<Themes.ThemesResponseData>({
    url: 'themes',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Read a theme and its styles. */
export function getThemeApi(id: string) {
  return request<Themes.ThemeResponseData>({
    url: `themes/${encodeURIComponent(id)}`,
    method: 'get',
    errorOwner: 'caller',
  })
}
