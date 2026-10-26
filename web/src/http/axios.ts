import type { AxiosRequestConfig, AxiosResponse } from 'axios'
import { reportError } from '@@/utils/notifications'
import axios, { AxiosHeaders, CanceledError, isAxiosError, isCancel } from 'axios'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data: Record<string, unknown> = {}, readonly code = status * 100) {
    super(message)
  }
}
interface RequestConfig extends Omit<AxiosRequestConfig<unknown>, 'auth'> {
  anonymous?: boolean
  errorOwner?: 'request' | 'caller'
  /** 原文和下载需要 ETag、Content-Disposition 等响应头。 */
  returnResponse?: boolean
}
const instance = axios.create({ baseURL: '/api/v1', adapter: 'fetch', withCredentials: false })
function envelope(value: unknown, status: number): ApiResponseData<unknown> {
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'number'
    || !Number.isInteger(value.code) || !('data' in value) || !('message' in value) || typeof value.message !== 'string') {
    throw new ApiError(status, '服务器响应协议无效')
  }
  return value as ApiResponseData<unknown>
}
function errorData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
async function failure(error: unknown): Promise<ApiError> {
  if (!isAxiosError(error) || !error.response) return error instanceof ApiError ? error : new ApiError(0, error instanceof Error ? error.message : '请求失败')
  const response = error.response
  let body: unknown = response.data
  if (body instanceof Blob) body = await body.text()
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return new ApiError(response.status, `请求失败（HTTP ${response.status}）`)
    }
  }
  try {
    const data = envelope(body, response.status)
    return new ApiError(response.status, data.message, errorData(data.data), data.code)
  } catch (cause) {
    if (cause instanceof ApiError) return cause
    throw cause
  }
}
export function request<T>(config: RequestConfig & { returnResponse: true }): Promise<AxiosResponse<T, unknown, AxiosHeaders>>
export function request<T>(config: RequestConfig): Promise<T>
export async function request<T>(config: RequestConfig): Promise<T | AxiosResponse<T, unknown, AxiosHeaders>> {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  const token = config.anonymous === true ? '' : user.token
  const headers = new AxiosHeaders(config.headers as ConstructorParameters<typeof AxiosHeaders>[0])
  headers.set('Authorization', token ? `Bearer ${token}` : undefined)
  try {
    const response = await instance.request<T, AxiosResponse<T, unknown, AxiosHeaders>>({
      ...config,
      headers,
      signal: config.signal ? AbortSignal.any([user.getSessionSignal(), config.signal as AbortSignal]) : user.getSessionSignal(),
      fetchOptions: { ...config.fetchOptions, credentials: 'omit', cache: 'no-store' },
    })
    user.assertSession(version)
    if (response.status === 204) return config.returnResponse ? response : undefined as T
    if (!config.responseType || config.responseType === 'json') {
      const result = envelope(response.data, response.status)
      if (result.code !== 0) throw new ApiError(response.status, result.message, errorData(result.data), result.code)
    }
    return config.returnResponse ? response : response.data
  } catch (cause) {
    if (isCancel(cause)) throw cause
    if (version !== user.getSessionVersion()) throw new CanceledError('会话已变化')
    const error = await failure(cause)
    user.assertSession(version)
    if (error.status === 401 && token) user.invalidate(version)
    if (config.errorOwner !== 'caller') reportError(error)
    throw error
  }
}
