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
