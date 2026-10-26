export interface LoginRequestData { password: string, captchaId: string, captchaCode: string }
export interface SetupRequestData { password: string }
export interface CaptchaRequestData { replaceId?: string }
export interface PasswordRequestData { current: string, next: string }
export interface LoginResult { token: string, expiresAt: string }
export interface Identity { permissions: string[], expiresAt: string }
export interface Captcha { captchaId: string, imageDataUrl: string, expiresAt: string }
export interface ResourceTicket { url: string, expiresAt: string }
export type TicketRequestData = { kind: 'images' | 'fonts' | 'events' } | { kind: 'plugin', pluginId: string, revision: string }
export type StateResponseData = ApiResponseData<{ setUp: boolean }>
export type LoginResponseData = ApiResponseData<LoginResult>
export type IdentityResponseData = ApiResponseData<Identity>
export type CaptchaResponseData = ApiResponseData<Captcha>
export type TicketResponseData = ApiResponseData<ResourceTicket>
export type PasswordResponseData = ApiResponseData<{ ok: boolean }>
