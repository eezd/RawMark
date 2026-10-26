import type * as Trash from './type'
import { request } from '@/http/axios'

/** Read the recycle bin. */
export function getTrashApi() {
  return request<Trash.TrashResponseData>({
    url: 'trash',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Restore a recycle-bin entry. */
export function restoreTrashApi(id: string) {
  return request<Trash.RestoreTrashResponseData>({
    url: `trash/${encodeURIComponent(id)}/restore`,
    method: 'post',
    errorOwner: 'caller',
  })
}

/** Empty the recycle bin and return per-entry results. */
export function clearTrashApi() {
  return request<Trash.ClearTrashResponseData>({
    url: 'trash',
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** Permanently delete a recycle-bin entry. */
export function purgeTrashApi(id: string) {
  return request<Trash.PurgeTrashResponseData>({
    url: `trash/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}
