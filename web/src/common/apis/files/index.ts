import type * as Files from './type'
import { encodePath } from '@@/utils/paths'
import { request } from '@/http/axios'

/** 读取 Markdown 原文与版本。 */
export function getFileApi(path: string) {
  return request<string>({
    url: `files/${encodePath(path)}`,
    method: 'get',
    responseType: 'text',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** 按版本写入 Markdown。 */
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

/** 移入回收站。 */
export function deleteFileApi(path: string) {
  return request<Files.DeleteFileResponseData>({
    url: `files/${encodePath(path)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** 创建文件夹。 */
export function createFolderApi(data: Files.FileRequestData) {
  return request<Files.FileOperationResponseData>({
    url: 'folders',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** 移动文件或目录。 */
export function moveFileApi(data: Files.MoveRequestData) {
  return request<Files.FileOperationResponseData>({
    url: 'move',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** 导入 Markdown 或 ZIP。 */
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

/** 导出选中内容为 Markdown ZIP。 */
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

/** 下载原始文件。 */
export function getRawFileApi(path: string) {
  return request<Blob>({
    url: `raw/${encodePath(path)}`,
    method: 'get',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}
