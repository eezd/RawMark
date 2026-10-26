import type * as Metadata from './type'
import { request } from '@/http/axios'

/** 读取笔记元数据索引。 */
export function getMetadataApi() {
  return request<Metadata.MetadataResponseData>({
    url: 'metadata',
    method: 'get',
    errorOwner: 'caller',
  })
}
