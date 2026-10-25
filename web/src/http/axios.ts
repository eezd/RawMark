import type { AxiosResponse, Method } from 'axios'
import { reportError } from '@@/utils/notifications'
import axios, { CanceledError, isAxiosError, isCancel } from 'axios'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data: Record<string, unknown> = {}, readonly code = status * 100) {
    super(message)
  }
}
interface Options {
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  keepalive?: boolean
  auth?: boolean
  errorOwner?: 'request' | 'caller'
  signal?: AbortSignal
}
const instance = axios.create({ baseURL: '/api/v1', adapter: 'fetch', withCredentials: false })
export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}
interface Envelope { code: number, data: unknown, message: string }
function envelope(value: unknown, status: number): Envelope {
  if (!value || typeof value !== 'object' || !('code' in value) || typeof value.code !== 'number'
    || !Number.isInteger(value.code) || !('data' in value) || !('message' in value) || typeof value.message !== 'string') {
    throw new ApiError(status, '服务器响应协议无效')
  }
  return value as Envelope
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
    return cause instanceof ApiError ? cause : new ApiError(response.status, '服务器响应协议无效')
  }
}
async function execute<T>(method: string, url: string, options: Options, raw: boolean, decode: (response: AxiosResponse) => Promise<T>): Promise<T> {
  const user = useUserStore(pinia)
  const version = user.getSessionVersion()
  const token = options.auth === false ? '' : user.token
  try {
    const response = await instance.request({
      method: method as Method,
      url,
      headers: { 'Content-Type': options.json !== undefined ? 'application/json' : null, ...options.headers, 'Authorization': token ? `Bearer ${token}` : undefined },
      data: options.json !== undefined ? JSON.stringify(options.json) : options.body,
      responseType: raw ? 'blob' : 'text',
      signal: options.signal ? AbortSignal.any([user.getSessionSignal(), options.signal]) : user.getSessionSignal(),
      fetchOptions: { credentials: 'omit', cache: 'no-store', keepalive: options.keepalive },
    })
    user.assertSession(version)
    const result = await decode(response)
    user.assertSession(version)
    return result
  } catch (cause) {
    if (isCancel(cause)) throw cause
    if (version !== user.getSessionVersion()) throw new CanceledError('会话已变化')
    const error = await failure(cause)
    user.assertSession(version)
    if (error.status === 401 && token) user.invalidate(version)
    if (options.errorOwner !== 'caller') reportError(error)
    throw error
  }
}
export function requestJSON<T>(method: string, url: string, options: Options = {}): Promise<T> {
  return execute(method, url, options, false, async (response) => {
    if (response.status === 204) return null as T
    let parsed: unknown
    try {
      parsed = JSON.parse(response.data)
    } catch {
      throw new ApiError(response.status, '服务器返回了无效 JSON')
    }
    const result = envelope(parsed, response.status)
    if (result.code !== 0) throw new ApiError(response.status, result.message, errorData(result.data), result.code)
    return result.data as T
  })
}
export function requestRaw(method: string, url: string, options: Options = {}): Promise<Response> {
  return execute(method, url, options, true, async (response) => {
    const headers = new Headers()
    for (const [key, value] of Object.entries(response.headers)) {
      if (value != null) headers.set(key, String(value))
    }
    return new Response(response.status === 204 ? null : response.data, { status: response.status, headers })
  })
}
