import type * as Assets from './type'
import { encodePath } from '@@/utils/paths'
import { request } from '@/http/axios'

/** Upload an image for a note. */
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

/** Upload an image for a folder. */
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

/** Replace an image at its existing path. */
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

/** Download and import a remote image. */
export function importImageApi(data: Assets.ImportImageRequestData) {
  return request<Assets.ImageResponseData>({
    url: 'assets/import',
    method: 'post',
    params: { note: data.note },
    data: { url: data.url },
    errorOwner: 'caller',
  })
}

/** Clean up images after checking references. */
export function cleanupImagesApi(data: Assets.CleanupImagesRequestData) {
  return request<Assets.CleanupImagesResponseData>({
    url: 'assets/cleanup',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}
