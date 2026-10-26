import type * as Storage from './type'
import { request } from '@/http/axios'

/** Measure actual storage usage. */
export function getStorageApi() {
  return request<Storage.StorageResponseData>({
    url: 'storage',
    method: 'get',
    errorOwner: 'caller',
  })
}
