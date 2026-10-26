export interface TrashItem {
  id: string
  path: string
  dir: boolean
  deletedAt: number
}

export interface TrashPurgeResult {
  deleted: string[]
  failed: { id: string, error: string }[]
}

export type TrashResponseData = ApiResponseData<{ items: TrashItem[] }>
export type RestoreTrashResponseData = ApiResponseData<TrashItem>
export type ClearTrashResponseData = ApiResponseData<TrashPurgeResult>
export type PurgeTrashResponseData = ApiResponseData<{ ok: boolean }>
