import type { TrashItem } from '../trash/type'

export interface UploadImageRequestData { note: string, file: File }
export interface FolderImageRequestData { folder: string, file: File }
export interface ReplaceImageRequestData { path: string, file: File }
export interface ImportImageRequestData { note: string, url: string }
export interface CleanupImagesRequestData { paths: string[] }
export type ImageResponseData = ApiResponseData<{ link: string }>
export type ReplaceImageResponseData = ApiResponseData<{ ok: boolean }>
export type CleanupImagesResponseData = ApiResponseData<{ deleted: TrashItem[], skipped: { path: string, reason: string }[] }>
