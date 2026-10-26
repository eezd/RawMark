import type * as Tokens from './type'
import { request } from '@/http/axios'

/** List API tokens. */
export function getTokensApi() {
  return request<Tokens.TokensResponseData>({
    url: 'tokens',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Create an API token. */
export function createTokenApi(data: Tokens.CreateTokenRequestData) {
  return request<Tokens.CreateTokenResponseData>({
    url: 'tokens',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** Revoke an API token. */
export function deleteTokenApi(id: string) {
  return request<Tokens.DeleteTokenResponseData>({
    url: `tokens/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}
