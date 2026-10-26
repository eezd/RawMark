export interface MaintenanceStatus { busy: boolean, operation: string, error: string, finishedAt: number, backup?: string }
export interface BackupSummary { kind: 'full' | 'settings', createdAt: number, entries: number, size: number }
export type BackupKind = 'full' | 'settings'
export interface BackupUploadRequestData { kind: BackupKind, size: number }
export interface BackupChunkRequestData { id: string, offset: number, body: Blob }
export type MaintenanceResponseData = ApiResponseData<MaintenanceStatus>
export type BackupUploadResponseData = ApiResponseData<{ id: string }>
export type BackupChunkResponseData = ApiResponseData<{ offset: number }>
export type BackupSummaryResponseData = ApiResponseData<BackupSummary>
export type MaintenanceOperationResponseData = ApiResponseData<{ ok: boolean }>
export type RestoreBackupResponseData = ApiResponseData<{ restarting: boolean }>
export type ClearTempResponseData = ApiResponseData<{ files: number, bytes: number, failed: string[] }>
