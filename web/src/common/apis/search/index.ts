import type * as Search from './type'
import { request } from '@/http/axios'

/** 搜索笔记。 */
export function searchApi(params: Search.SearchRequestData) {
  return request<Search.SearchResponseData>({
    url: 'search',
    method: 'get',
    params,
    errorOwner: 'caller',
  })
}
