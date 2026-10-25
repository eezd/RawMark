import type { IconName } from '@@/utils/icons'

export type TreeIcon = { kind: 'emoji', value: string } | { kind: 'builtin', value: IconName }

export interface Entry {
  path: string
  dir: boolean
  size: number
  mtime: number
  icon?: TreeIcon
}
