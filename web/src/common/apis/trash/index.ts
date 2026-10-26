import type * as Trash from './type'
import { request } from '@/http/axios'

/** 读取回收站。 */
export function getTrashApi() {
  return request<Trash.TrashResponseData>({
    url: 'trash',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 恢复回收站条目。 */
export function restoreTrashApi(id: string) {
  return request<Trash.RestoreTrashResponseData>({
    url: `trash/${encodeURIComponent(id)}/restore`,
    method: 'post',
    errorOwner: 'caller',
  })
}

/** 清空回收站并返回逐项结果。 */
export function clearTrashApi() {
  return request<Trash.ClearTrashResponseData>({
    url: 'trash',
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** 永久删除回收站条目。 */
export function purgeTrashApi(id: string) {
  return request<Trash.PurgeTrashResponseData>({
    url: `trash/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}
