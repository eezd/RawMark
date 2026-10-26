import type * as Maintenance from './type'
import { request } from '@/http/axios'

/** Read maintenance status. */
export function getMaintenanceStatusApi() {
  return request<Maintenance.MaintenanceResponseData>({
    url: 'maintenance/status',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** Export an instance or settings backup. */
export function exportBackupApi(kind: Maintenance.BackupKind) {
  return request<Blob>({
    url: `maintenance/export/${kind}`,
    method: 'post',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** Export all Markdown notes. */
export function exportNotesApi() {
  return request<Blob>({
    url: 'maintenance/notes/export',
    method: 'post',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** Export system logs. */
export function exportLogsApi() {
  return request<Blob>({
    url: 'maintenance/logs/export',
    method: 'post',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** Create a backup upload. */
export function startBackupUploadApi(data: Maintenance.BackupUploadRequestData) {
  return request<Maintenance.BackupUploadResponseData>({
    url: 'maintenance/uploads',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** Upload backup chunks sequentially. */
export function uploadBackupChunkApi(data: Maintenance.BackupChunkRequestData) {
  return request<Maintenance.BackupChunkResponseData>({
    url: `maintenance/uploads/${encodeURIComponent(data.id)}`,
    method: 'put',
    data: data.body,
    headers: { 'Upload-Offset': String(data.offset) },
    errorOwner: 'caller',
  })
}

/** Validate the complete backup. */
export function validateBackupApi(id: string) {
  return request<Maintenance.BackupSummaryResponseData>({
    url: `maintenance/uploads/${encodeURIComponent(id)}/validate`,
    method: 'post',
    errorOwner: 'caller',
  })
}

/** Cancel a backup upload and remove staging files. */
export function cancelBackupUploadApi(id: string) {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: `maintenance/uploads/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** Import a confirmed settings backup. */
export function importSettingsApi(id: string) {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: 'maintenance/settings/import',
    method: 'post',
    data: { id, confirmed: true },
    errorOwner: 'caller',
  })
}

/** Restore a confirmed instance backup. */
export function restoreBackupApi(id: string) {
  return request<Maintenance.RestoreBackupResponseData>({
    url: 'maintenance/restore',
    method: 'post',
    data: { id, confirmed: true },
    errorOwner: 'caller',
  })
}

/** Back up and reset settings. */
export function resetSettingsApi() {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: 'maintenance/settings/reset',
    method: 'post',
    data: { confirmed: true },
    errorOwner: 'caller',
  })
}

/** Optimize or rebuild the derived index. */
export function maintainIndexApi(operation: 'optimize' | 'rebuild') {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: `maintenance/index/${operation}`,
    method: 'post',
    errorOwner: 'caller',
  })
}

/** Clean inactive temporary files. */
export function clearTempApi() {
  return request<Maintenance.ClearTempResponseData>({
    url: 'maintenance/temp/clear',
    method: 'post',
    errorOwner: 'caller',
  })
}
