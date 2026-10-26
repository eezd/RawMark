import type * as Maintenance from './type'
import { request } from '@/http/axios'

/** 读取维护状态。 */
export function getMaintenanceStatusApi() {
  return request<Maintenance.MaintenanceResponseData>({
    url: 'maintenance/status',
    method: 'get',
    errorOwner: 'caller',
  })
}

/** 导出实例或设置备份。 */
export function exportBackupApi(kind: Maintenance.BackupKind) {
  return request<Blob>({
    url: `maintenance/export/${kind}`,
    method: 'post',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** 导出全部 Markdown 笔记。 */
export function exportNotesApi() {
  return request<Blob>({
    url: 'maintenance/notes/export',
    method: 'post',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** 导出系统日志。 */
export function exportLogsApi() {
  return request<Blob>({
    url: 'maintenance/logs/export',
    method: 'post',
    responseType: 'blob',
    returnResponse: true,
    errorOwner: 'caller',
  })
}

/** 创建备份上传。 */
export function startBackupUploadApi(data: Maintenance.BackupUploadRequestData) {
  return request<Maintenance.BackupUploadResponseData>({
    url: 'maintenance/uploads',
    method: 'post',
    data,
    errorOwner: 'caller',
  })
}

/** 顺序上传备份分块。 */
export function uploadBackupChunkApi(data: Maintenance.BackupChunkRequestData) {
  return request<Maintenance.BackupChunkResponseData>({
    url: `maintenance/uploads/${encodeURIComponent(data.id)}`,
    method: 'put',
    data: data.body,
    headers: { 'Upload-Offset': String(data.offset) },
    errorOwner: 'caller',
  })
}

/** 校验完整备份。 */
export function validateBackupApi(id: string) {
  return request<Maintenance.BackupSummaryResponseData>({
    url: `maintenance/uploads/${encodeURIComponent(id)}/validate`,
    method: 'post',
    errorOwner: 'caller',
  })
}

/** 取消备份上传并清理暂存。 */
export function cancelBackupUploadApi(id: string) {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: `maintenance/uploads/${encodeURIComponent(id)}`,
    method: 'delete',
    errorOwner: 'caller',
  })
}

/** 导入已确认的设置备份。 */
export function importSettingsApi(id: string) {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: 'maintenance/settings/import',
    method: 'post',
    data: { id, confirmed: true },
    errorOwner: 'caller',
  })
}

/** 恢复已确认的实例备份。 */
export function restoreBackupApi(id: string) {
  return request<Maintenance.RestoreBackupResponseData>({
    url: 'maintenance/restore',
    method: 'post',
    data: { id, confirmed: true },
    errorOwner: 'caller',
  })
}

/** 备份后重置设置。 */
export function resetSettingsApi() {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: 'maintenance/settings/reset',
    method: 'post',
    data: { confirmed: true },
    errorOwner: 'caller',
  })
}

/** 优化或重建派生索引。 */
export function maintainIndexApi(operation: 'optimize' | 'rebuild') {
  return request<Maintenance.MaintenanceOperationResponseData>({
    url: `maintenance/index/${operation}`,
    method: 'post',
    errorOwner: 'caller',
  })
}

/** 清理非活动临时文件。 */
export function clearTempApi() {
  return request<Maintenance.ClearTempResponseData>({
    url: 'maintenance/temp/clear',
    method: 'post',
    errorOwner: 'caller',
  })
}
