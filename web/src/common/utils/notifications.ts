import { isCancel } from 'axios'
import { shallowReactive } from 'vue'

export interface Toast { id: number, text: string, action?: { label: string, run: () => void } }
export const toasts = shallowReactive<Toast[]>([])
let nextID = 0
export function dismissToast(id: number) {
  const i = toasts.findIndex(t => t.id === id); if (i >= 0)toasts.splice(i, 1)
}
export function toast(text: string, action?: Toast['action']) {
  const item = { id: ++nextID, text, action }; toasts.push(item); setTimeout(dismissToast, action ? 6000 : 3500, item.id)
}
export function reportError(error: unknown) {
  if (!isCancel(error))toast(error instanceof Error ? error.message : String(error))
}
