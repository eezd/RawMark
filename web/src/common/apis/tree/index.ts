import type * as Tree from './type'
import { request } from '@/http/axios'

/** Read the directory tree. */
export function getTreeApi() {
  return request<Tree.TreeResponseData>({
    url: 'tree',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Set or reset a tree entry's icon. */
export function setTreeIconApi(data: Tree.TreeIconRequestData) {
  return request<Tree.TreeIconResponseData>({
    url: 'tree-icon',
    method: 'put',
    data,
    errorOwner: 'caller',
  })
}
