/** 保留插件写入的未知设置，应用端按已知字段校验。 */
export type SettingsData = Record<string, unknown>
export type SettingsResponseData = ApiResponseData<SettingsData>
