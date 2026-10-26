import type * as Fonts from './type'
import { request } from '@/http/axios'

/** 读取导入字体目录。 */
export function getFontsApi() {
  return request<Fonts.FontsResponseData>({
    url: 'fonts',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 导入字体。 */
export function importFontApi(file: File) {
  const data = new FormData()
  data.append('file', file)
  return request<Fonts.ImportFontResponseData>({
    url: 'fonts',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** 删除导入字体。 */
export function deleteFontApi(id: string) {
  return request<Fonts.DeleteFontResponseData>({
    url: `fonts/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}
