export interface ApiToken { id: string, name: string, scope: 'read' | 'write', createdAt: number, lastUsedAt: number }
export interface CreateTokenRequestData { name: string, scope: ApiToken['scope'] }
export type TokensResponseData = ApiResponseData<{ tokens: ApiToken[] }>
export type CreateTokenResponseData = ApiResponseData<{ token: string, info: ApiToken }>
export type DeleteTokenResponseData = ApiResponseData<{ ok: boolean }>
