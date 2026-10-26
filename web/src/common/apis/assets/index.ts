import type * as Assets from './type'
import { encodePath } from '@@/utils/paths'
import { request } from '@/http/axios'

/** 上传笔记图片。 */
export function uploadImageApi(data: Assets.UploadImageRequestData) {
  const body = new FormData()
  body.append('file', data.file, data.file.name || 'image')
  return request<Assets.ImageResponseData>({
    url: 'assets',
    method: 'post',
    params: { note: data.note },
    data: body,
    errorOwner: 'caller',
  })
}

/** 上传目录图片。 */
export function uploadFolderImageApi(data: Assets.FolderImageRequestData) {
  const body = new FormData()
  body.append('file', data.file)
  return request<Assets.ImageResponseData>({
    url: 'assets',
    method: 'post',
    params: { folder: data.folder },
    data: body,
    errorOwner: 'caller',
  })
}

/** 替换原路径图片。 */
export function replaceImageApi(data: Assets.ReplaceImageRequestData) {
  const body = new FormData()
  body.append('file', data.file)
  return request<Assets.ReplaceImageResponseData>({
    url: `assets/${encodePath(data.path)}`,
    method: 'put',
    data: body,
    errorOwner: 'caller',
  })
}

/** 下载并导入远程图片。 */
export function importImageApi(data: Assets.ImportImageRequestData) {
  return request<Assets.ImageResponseData>({
    url: 'assets/import',
    method: 'post',
    params: { note: data.note },
    data: { url: data.url },
    errorOwner: 'caller',
  })
}

/** 核对引用后清理图片。 */
export function cleanupImagesApi(data: Assets.CleanupImagesRequestData) {
  return request<Assets.CleanupImagesResponseData>({
    url: 'assets/cleanup',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}
