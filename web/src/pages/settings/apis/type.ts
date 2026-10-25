export interface StorageUsage {
  totalSize: number
  categories: { id: 'vault' | 'databases' | 'fonts' | 'themes' | 'plugins' | 'other', size: number }[]
  builtinFontsSize: number
  customFontsSize: number
  assetsSize: number
  trashSize: number
  calculatedAt: number
}

export interface MaintenanceStatus { busy: boolean, operation: string, error: string, finishedAt: number, backup?: string }

export interface BackupSummary { kind: 'full' | 'settings', createdAt: number, entries: number, size: number }

export type BackupKind = 'full' | 'settings'

export interface ApiToken {
  id: string
  name: string
  scope: 'read' | 'write'
  createdAt: number
  // 0 为从未使用
  lastUsedAt: number
}
