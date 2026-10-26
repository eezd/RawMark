import type * as Metadata from './type'
import { request } from '@/http/axios'

/** Read indexed note metadata. */
export function getMetadataApi() {
  return request<Metadata.MetadataResponseData>({
    url: 'metadata',
    method: 'get',
    errorOwner: 'caller',
  })
}
