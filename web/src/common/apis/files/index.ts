import type * as Files from './type'
import { encodePath } from '@@/utils/paths'
import { request } from '@/http/axios'

/** Read original Markdown and its revision. */
export function getFileApi(path: string) {
  return request<string>({
    url: `files/${encodePath(path)}`,
    method: 'get',
    responseType: 'text',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** Write Markdown with a revision precondition. */
export function writeFileApi(data: Files.WriteFileRequestData) {
  const headers: Record<string, string> = { 'Content-Type': 'text/markdown; charset=utf-8' }
  if (data.ifMatch === '') headers['If-None-Match'] = '*'
  else if (data.ifMatch !== undefined) headers['If-Match'] = `"${data.ifMatch}"`
  return request<Files.WriteFileResponseData>({
    url: `files/${encodePath(data.path)}`,
    method: 'put',
    data: data.content,
    headers,
    fetchOptions: { keepalive: !!data.keepalive && new Blob([data.content]).size < 60_000 },
    errorOwner: 'caller',
  })
}

/** Move an item to the recycle bin. */
export function deleteFileApi(path: string) {
  return request<Files.DeleteFileResponseData>({
    url: `files/${encodePath(path)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** Create a folder. */
export function createFolderApi(data: Files.FileRequestData) {
  return request<Files.FileOperationResponseData>({
    url: 'folders',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** Move a file or folder. */
export function moveFileApi(data: Files.MoveRequestData) {
  return request<Files.FileOperationResponseData>({
    url: 'move',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** Import Markdown or a ZIP archive. */
export function importNotesApi(data: Files.ImportRequestData) {
  const body = new FormData()
  body.append('dir', data.dir)
  body.append('folder', data.folder)
  for (const file of data.files) body.append('files', file)
  return request<Files.ImportResponseData>({
    url: 'import',
    method: 'post',
    data: body,
    errorOwner: 'caller',
  })
}

/** Export selected contents as a Markdown ZIP. */
export function exportFilesApi(data: Files.ExportRequestData) {
  return request<Blob>({
    url: 'export',
    method: 'post',
    data,
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** Download a raw file. */
export function getRawFileApi(path: string) {
  return request<Blob>({
    url: `raw/${encodePath(path)}`,
    method: 'get',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}
