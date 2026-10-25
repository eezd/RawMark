import { requestJSON } from '@/http/axios'

export interface LoginResult { token: string, expiresAt: string }
export interface Identity { permissions: string[], expiresAt: string }
export interface Captcha { captchaId: string, imageDataUrl: string, expiresAt: string }
export interface ResourceTicket { url: string, expiresAt: string }
export type TicketRequest = { kind: 'images' | 'fonts' | 'events' } | { kind: 'plugin', pluginId: string, revision: string }
export const authApi = {
  state: () => requestJSON<{ setUp: boolean }>('GET', '/auth/state', { auth: false, errorOwner: 'caller' }),
  captcha: (replaceId?: string) => requestJSON<Captcha>('POST', '/auth/captcha', { auth: false, json: { replaceId }, errorOwner: 'caller' }),
  setup: (password: string) => requestJSON<LoginResult>('POST', '/auth/setup', { auth: false, json: { password }, errorOwner: 'caller' }),
  login: (password: string, captchaId: string, captchaCode: string) => requestJSON<LoginResult>('POST', '/auth/login', { auth: false, json: { password, captchaId, captchaCode }, errorOwner: 'caller' }),
  me: () => requestJSON<Identity>('GET', '/auth/me', { errorOwner: 'caller' }),
  logout: () => requestJSON<null>('POST', '/auth/logout'),
  ticket: (data: TicketRequest) => requestJSON<ResourceTicket>('POST', '/auth/tickets', { json: data }),
}
