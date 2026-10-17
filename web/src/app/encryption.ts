// 加密会话：解锁后主密钥只在内存中，关闭页面即失效（用户选择不做空闲超时），另可手动锁定。
// 笔记的读写与转换在 workspace.ts，这里只管主密钥、密码对话框与加密图片
import { reactive } from 'vue'
import { api } from './api'
import { createKeyring, decryptAsset, encryptAsset, parseKeyring, rewrapKeyring, unlockKeyring } from './crypto'

export type KeyDialogMode = 'unlock' | 'setup' | 'change'

export const keyState = reactive({
  // 浏览器只在安全上下文（HTTPS 或 localhost）提供 WebCrypto
  supported: window.isSecureContext && globalThis.crypto?.subtle !== undefined,
  unlocked: false,
  dialog: null as KeyDialogMode | null,
})

let master: CryptoKey | null = null
let dialogDone: ((ok: boolean) => void) | null = null
// 已解密图片：/api/v1/raw 地址 → blob 地址。图片文件名是内容哈希，内容不会变
const images = new Map<string, Promise<string>>()

export function masterKey(): CryptoKey {
  if (!master) throw new Error('加密笔记已锁定')
  return master
}

/** 确保已解锁：未解锁时弹出解锁对话框（从未设置过密码则为设置对话框），返回是否已解锁 */
export async function ensureUnlocked(): Promise<boolean> {
  if (master) return true
  if (!keyState.supported) return false
  return openKeyDialog((await api.keyring()) ? 'unlock' : 'setup')
}

/** 打开密码对话框，在对话框完成（true）或取消（false）时返回 */
export function openKeyDialog(mode: KeyDialogMode): Promise<boolean> {
  dialogDone?.(false)
  keyState.dialog = mode
  return new Promise((resolve) => (dialogDone = resolve))
}

export function closeKeyDialog(ok: boolean) {
  keyState.dialog = null
  const done = dialogDone
  dialogDone = null
  done?.(ok)
}

export async function unlock(password: string) {
  const k = await api.keyring()
  if (!k) throw new Error('尚未设置加密密码')
  master = await unlockKeyring(parseKeyring(k.text), password)
  keyState.unlocked = true
}

/** 首次设置加密密码；其他设备抢先设置时服务器返回 409 */
export async function setupKeyring(password: string) {
  const created = await createKeyring(password)
  await api.putKeyring(JSON.stringify(created.keyring), '')
  master = created.master
  keyState.unlocked = true
}

export async function changePassword(oldPassword: string, newPassword: string) {
  const k = await api.keyring()
  if (!k) throw new Error('尚未设置加密密码')
  const next = await rewrapKeyring(parseKeyring(k.text), oldPassword, newPassword)
  await api.putKeyring(JSON.stringify(next), k.rev)
}

/** 丢弃主密钥与已解密的图片；打开的加密笔记由调用方处理 */
export function lockKey() {
  master = null
  keyState.unlocked = false
  for (const url of images.values()) void url.then(URL.revokeObjectURL, () => {})
  images.clear()
}

export function loadEncryptedImage(url: string): Promise<string> {
  let loading = images.get(url)
  if (!loading) {
    loading = api
      .raw(url)
      .then(async (blob) => URL.createObjectURL(await decryptAsset(masterKey(), await blob.arrayBuffer())))
    // 失败的不缓存，下次显示时重试
    loading.catch(() => images.delete(url))
    images.set(url, loading)
  }
  return loading
}

/** 加密图片供上传；服务器对加密笔记的图片一律存为 .enc，类型记录在密文中 */
export async function encryptImage(image: Blob): Promise<File> {
  return new File([await encryptAsset(masterKey(), await image.arrayBuffer(), image.type)], 'image.enc')
}

/** 解密图片供上传为普通图片；扩展名取自原始类型（如 image/svg+xml → .svg），服务器据此命名 */
export async function decryptImage(file: Blob): Promise<File> {
  const image = await decryptAsset(masterKey(), await file.arrayBuffer())
  const ext = /^image\/([a-z0-9]{1,8})/.exec(image.type)?.[1] ?? 'bin'
  return new File([image], 'image.' + ext, { type: image.type })
}
