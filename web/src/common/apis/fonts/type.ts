export interface CustomFont { id: string, name: string, format: 'ttf' | 'otf' | 'woff' | 'woff2' }
export type FontsResponseData = ApiResponseData<{ fonts: CustomFont[] }>
export type ImportFontResponseData = ApiResponseData<CustomFont>
export type DeleteFontResponseData = ApiResponseData<{ ok: boolean }>
