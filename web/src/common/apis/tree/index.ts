import type * as Tree from './type'
import { request } from '@/http/axios'

/** 读取目录树。 */
export function getTreeApi() {
  return request<Tree.TreeResponseData>({
    url: 'tree',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 设置或重置目录项图标。 */
export function setTreeIconApi(data: Tree.TreeIconRequestData) {
  return request<Tree.TreeIconResponseData>({
    url: 'tree-icon',
    method: 'put',
    data,
    errorOwner: 'caller',
  })
}
