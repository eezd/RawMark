import type { ApiToken, BackupKind, BackupSummary, MaintenanceStatus, StorageUsage } from './type'
import { requestJSON, requestRaw } from '@/http/axios'

export const settingsApi = {
  changePassword: (current: string, next: string) => requestJSON('POST', '/auth/password', { errorOwner: 'caller', json: { current, next } }),
  maintenanceStatus: () => requestJSON<MaintenanceStatus>('GET', '/maintenance/status', { errorOwner: 'caller' }),
  exportBackup: (kind: BackupKind) => requestRaw('POST', `/maintenance/export/${kind}`, { errorOwner: 'caller' }),
  exportNotes: () => requestRaw('POST', '/maintenance/notes/export', { errorOwner: 'caller' }),
  startBackupUpload: (kind: BackupKind, size: number) => requestJSON<{ id: string }>('POST', '/maintenance/uploads', { errorOwner: 'caller', json: { kind, size } }),
  uploadBackupChunk: (id: string, offset: number, body: Blob) => requestJSON<{ offset: number }>('PUT', `/maintenance/uploads/${id}`, { errorOwner: 'caller', body, headers: { 'Upload-Offset': String(offset) } }),
  validateBackup: (id: string) => requestJSON<BackupSummary>('POST', `/maintenance/uploads/${id}/validate`, { errorOwner: 'caller' }),
  cancelBackupUpload: (id: string) => requestJSON('DELETE', `/maintenance/uploads/${id}`, { errorOwner: 'caller' }),
  importSettings: (id: string) => requestJSON('POST', '/maintenance/settings/import', { errorOwner: 'caller', json: { id, confirmed: true } }),
  restoreBackup: (id: string) => requestJSON('POST', '/maintenance/restore', { errorOwner: 'caller', json: { id, confirmed: true } }),
  resetSettings: () => requestJSON('POST', '/maintenance/settings/reset', { errorOwner: 'caller', json: { confirmed: true } }),
  maintainIndex: (operation: 'optimize' | 'rebuild') => requestJSON('POST', `/maintenance/index/${operation}`, { errorOwner: 'caller' }),
  clearTemp: () => requestJSON<{ files: number, bytes: number, failed: string[] }>('POST', '/maintenance/temp/clear', { errorOwner: 'caller' }),
  exportLogs: () => requestRaw('POST', '/maintenance/logs/export', { errorOwner: 'caller' }),
  tokens: async () => (await requestJSON<{ tokens: ApiToken[] }>('GET', '/tokens', { errorOwner: 'caller' })).tokens,
  createToken: (name: string, scope: ApiToken['scope']) =>
    requestJSON<{ token: string, info: ApiToken }>('POST', '/tokens', { errorOwner: 'caller', json: { name, scope } }),
  deleteToken: (id: string) => requestJSON('DELETE', `/tokens/${encodeURIComponent(id)}`, { errorOwner: 'caller' }),
  storage: () => requestJSON<StorageUsage>('GET', '/storage', { errorOwner: 'caller' }),
}
