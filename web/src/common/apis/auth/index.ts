import type * as Auth from './type'
import { request } from '@/http/axios'

/** 查询初始化状态。 */
export function getAuthStateApi() {
  return request<Auth.StateResponseData>({
    url: 'auth/state',
    method: 'get',
    anonymous: true,
    errorOwner: 'caller',
  })
}

/** 签发或刷新登录验证码。 */
export function getCaptchaApi(data: Auth.CaptchaRequestData) {
  return request<Auth.CaptchaResponseData>({
    url: 'auth/captcha',
    method: 'post',
    anonymous: true,
    data,
    errorOwner: 'caller',
  })
}

/** 初始化登录密码。 */
export function setupApi(data: Auth.SetupRequestData) {
  return request<Auth.LoginResponseData>({
    url: 'auth/setup',
    method: 'post',
    anonymous: true,
    data,
    errorOwner: 'caller',
  })
}

/** 使用密码和验证码登录。 */
export function loginApi(data: Auth.LoginRequestData) {
  return request<Auth.LoginResponseData>({
    url: 'auth/login',
    method: 'post',
    anonymous: true,
    data,
    errorOwner: 'caller',
  })
}

/** 恢复当前身份与权限。 */
export function getCurrentUserApi() {
  return request<Auth.IdentityResponseData>({
    url: 'auth/me',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 撤销当前服务端会话。 */
export function logoutApi() {
  return request<void>({
    url: 'auth/logout',
    method: 'post',
  })
}

/** 签发受限资源票据。 */
export function createResourceTicketApi(data: Auth.TicketRequestData) {
  return request<Auth.TicketResponseData>({
    url: 'auth/tickets',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** 修改登录密码。 */
export function changePasswordApi(data: Auth.PasswordRequestData) {
  return request<Auth.PasswordResponseData>({
    url: 'auth/password',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}
