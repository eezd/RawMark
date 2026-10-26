import type * as Storage from './type'
import { request } from '@/http/axios'

/** 统计实际存储占用。 */
export function getStorageApi() {
  return request<Storage.StorageResponseData>({
    url: 'storage',
    method: 'get',
    errorOwner: 'caller',
  })
}
