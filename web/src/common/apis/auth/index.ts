import type * as Auth from './type'
import { request } from '@/http/axios'

/** Query initialization status. */
export function getAuthStateApi() {
  return request<Auth.StateResponseData>({
    url: 'auth/state',
    method: 'get',
    anonymous: true,
    errorOwner: 'caller',
  })
}

/** Issue or refresh a sign-in captcha. */
export function getCaptchaApi(data: Auth.CaptchaRequestData) {
  return request<Auth.CaptchaResponseData>({
    url: 'auth/captcha',
    method: 'post',
    anonymous: true,
    data,
    errorOwner: 'caller',
  })
}

/** Initialize the login password. */
export function setupApi(data: Auth.SetupRequestData) {
  return request<Auth.LoginResponseData>({
    url: 'auth/setup',
    method: 'post',
    anonymous: true,
    data,
    errorOwner: 'caller',
  })
}

/** Sign in with a password and captcha. */
export function loginApi(data: Auth.LoginRequestData) {
  return request<Auth.LoginResponseData>({
    url: 'auth/login',
    method: 'post',
    anonymous: true,
    data,
    errorOwner: 'caller',
  })
}

/** Restore the current identity and permissions. */
export function getCurrentUserApi() {
  return request<Auth.IdentityResponseData>({
    url: 'auth/me',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Revoke the current server session. */
export function logoutApi() {
  return request<void>({
    url: 'auth/logout',
    method: 'post',
  })
}

/** Issue restricted resource tickets. */
export function createResourceTicketApi(data: Auth.TicketRequestData) {
  return request<Auth.TicketResponseData>({
    url: 'auth/tickets',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** Change the login password. */
export function changePasswordApi(data: Auth.PasswordRequestData) {
  return request<Auth.PasswordResponseData>({
    url: 'auth/password',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}
