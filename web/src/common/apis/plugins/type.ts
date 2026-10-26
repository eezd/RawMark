export interface InstalledPlugin {
  id: string
  name: string
  version: string
  apiVersion: 1
  revision: string
  enabled: boolean
}

export interface TogglePluginRequestData { id: string, enabled: boolean }
export interface PluginDataRequestData { id: string, data: unknown }
export type PluginsResponseData = ApiResponseData<{ plugins: InstalledPlugin[] }>
export type PluginResponseData = ApiResponseData<InstalledPlugin>
export type PluginDataResponseData = ApiResponseData<{ data: unknown }>
export type PluginOperationResponseData = ApiResponseData<{ ok: boolean }>
