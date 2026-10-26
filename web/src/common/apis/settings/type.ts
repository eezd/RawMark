/** Preserve unknown plugin settings; the application validates known fields. */
export type SettingsData = Record<string, unknown>
export type SettingsResponseData = ApiResponseData<SettingsData>
