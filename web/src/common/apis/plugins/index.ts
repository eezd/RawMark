import type * as Plugins from './type'
import { request } from '@/http/axios'

/** 读取已安装插件。 */
export function getPluginsApi() {
  return request<Plugins.PluginsResponseData>({
    url: 'plugins',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 安装插件 ZIP。 */
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

/** 启用或停用插件。 */
export function togglePluginApi(data: Plugins.TogglePluginRequestData) {
  return request<Plugins.PluginResponseData>({
    url: `plugins/${encodeURIComponent(data.id)}`,
    method: 'patch',
    data: { enabled: data.enabled },
    errorOwner: 'caller',
  })
}

/** 卸载插件并保留插件数据。 */
export function uninstallPluginApi(id: string) {
  return request<Plugins.PluginOperationResponseData>({
    url: `plugins/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** 读取插件存储。 */
export function getPluginDataApi(id: string) {
  return request<Plugins.PluginDataResponseData>({
    url: `plugins/${encodeURIComponent(id)}/data`,
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 保存插件存储。 */
export function savePluginDataApi(data: Plugins.PluginDataRequestData) {
  return request<Plugins.PluginDataResponseData>({
    url: `plugins/${encodeURIComponent(data.id)}/data`,
    method: 'put',
    data: { data: data.data },
    errorOwner: 'caller',
  })
}
