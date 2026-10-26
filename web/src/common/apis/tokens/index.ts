import type * as Tokens from './type'
import { request } from '@/http/axios'

/** 读取 API 令牌列表。 */
export function getTokensApi() {
  return request<Tokens.TokensResponseData>({
    url: 'tokens',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 创建 API 令牌。 */
export function createTokenApi(data: Tokens.CreateTokenRequestData) {
  return request<Tokens.CreateTokenResponseData>({
    url: 'tokens',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** 撤销 API 令牌。 */
export function deleteTokenApi(id: string) {
  return request<Tokens.DeleteTokenResponseData>({
    url: `tokens/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}
