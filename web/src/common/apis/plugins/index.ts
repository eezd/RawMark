import type * as Plugins from './type'
import { request } from '@/http/axios'

/** List installed plugins. */
export function getPluginsApi() {
  return request<Plugins.PluginsResponseData>({
    url: 'plugins',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Install a plugin ZIP. */
export function installPluginApi(file: File) {
  const data = new FormData()
  data.append('file', file)
  return request<Plugins.PluginResponseData>({
    url: 'plugins',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** Enable or disable a plugin. */
export function togglePluginApi(data: Plugins.TogglePluginRequestData) {
  return request<Plugins.PluginResponseData>({
    url: `plugins/${encodeURIComponent(data.id)}`,
    method: 'patch',
    data: { enabled: data.enabled },
    errorOwner: 'caller',
  })
}

/** Uninstall a plugin while retaining its data. */
export function uninstallPluginApi(id: string) {
  return request<Plugins.PluginOperationResponseData>({
    url: `plugins/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** Read plugin storage. */
export function getPluginDataApi(id: string) {
  return request<Plugins.PluginDataResponseData>({
    url: `plugins/${encodeURIComponent(id)}/data`,
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Save plugin storage. */
export function savePluginDataApi(data: Plugins.PluginDataRequestData) {
  return request<Plugins.PluginDataResponseData>({
    url: `plugins/${encodeURIComponent(data.id)}/data`,
    method: 'put',
    data: { data: data.data },
    errorOwner: 'caller',
  })
}
