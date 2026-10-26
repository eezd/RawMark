export interface StorageUsage { totalSize: number, categories: { id: 'vault' | 'databases' | 'fonts' | 'themes' | 'plugins' | 'other', size: number }[], builtinFontsSize: number, customFontsSize: number, assetsSize: number, trashSize: number, calculatedAt: number }
export type StorageResponseData = ApiResponseData<StorageUsage>
