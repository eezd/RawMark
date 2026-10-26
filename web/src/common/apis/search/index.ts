import type * as Search from './type'
import { request } from '@/http/axios'

/** Search notes. */
export function searchApi(params: Search.SearchRequestData) {
  return request<Search.SearchResponseData>({
    url: 'search',
    method: 'get',
    params,
    errorOwner: 'caller',
  })
}
