export interface Theme { id: string, name: string, version: string }
export type ThemesResponseData = ApiResponseData<{ themes: Theme[] }>
export type ThemeResponseData = ApiResponseData<Theme & { css: string }>
