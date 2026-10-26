import type { TrashItem } from '../trash/type'

export interface FileRequestData { path: string }
export interface WriteFileRequestData { path: string, content: string, ifMatch?: string, keepalive?: boolean }
export interface MoveRequestData { from: string, to: string }
export interface ImportRequestData { dir: string, folder: string, files: File[] }
export interface ExportRequestData { paths: string[] }
export interface ImportResult { paths: string[], notes: number, assets: number, warnings: string[] }
export type WriteFileResponseData = ApiResponseData<{ rev: string }>
export type DeleteFileResponseData = ApiResponseData<TrashItem>
export type FileOperationResponseData = ApiResponseData<{ ok: boolean }>
export type ImportResponseData = ApiResponseData<ImportResult>
