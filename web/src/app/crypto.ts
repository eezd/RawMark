// 笔记加密的密码学部分（设计见 docs/architecture.md §6）：
//   加密密码 →PBKDF2→ KEK，包裹随机主密钥，存于 .rawmark/keyring.json；
//   每篇笔记、每张图片各有一个随机 AES-256-GCM 数据密钥，由主密钥包裹后与密文存在一起。
// 全部使用 AES-GCM（含包裹），密码错误、文件被篡改都会在解密时失败而不是得到乱码

const PBKDF2_ITERATIONS = 600_000
const IV_BYTES = 12
// AES-256 原始密钥 32 字节 + GCM 认证标签 16 字节
const WRAPPED_KEY_BYTES = 48
// 加密图片的文件头 "RME1"
const ASSET_MAGIC = [0x52, 0x4d, 0x45, 0x31]

interface Wrapped {
  iv: string
  data: string
}

export interface Keyring {
  v: 1
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
  // 被 KEK 包裹的主密钥
  key: Wrapped
}

// 加密笔记（.md.enc）的文件内容
interface NoteEnvelope {
  v: 1
  // 被主密钥包裹的笔记密钥
  key: Wrapped
  iv: string
  data: string
}

/** 已解开的笔记密钥；保留包裹后的形式，每次保存只需重新加密正文 */
export interface NoteKey {
  key: CryptoKey
  wrapped: Wrapped
}

export class WrongPasswordError extends Error {
  constructor() {
    super('加密密码错误')
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const gcm = (iv: Uint8Array<ArrayBuffer>): AesGcmParams => ({ name: 'AES-GCM', iv })
const AES: AesKeyGenParams = { name: 'AES-GCM', length: 256 }
const MASTER_USAGES: KeyUsage[] = ['wrapKey', 'unwrapKey']
const DATA_USAGES: KeyUsage[] = ['encrypt', 'decrypt']

// GCM 认证失败在 WebCrypto 中表现为 OperationError
const isAuthFailure = (err: unknown) => err instanceof DOMException && err.name === 'OperationError'

async function wrap(key: CryptoKey, wrappingKey: CryptoKey): Promise<Wrapped> {
  const iv = randomBytes(IV_BYTES)
  const data = await crypto.subtle.wrapKey('raw', key, wrappingKey, gcm(iv))
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
}

function unwrap(w: Wrapped, wrappingKey: CryptoKey, usages: KeyUsage[], extractable = false): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey('raw', fromBase64(w.data), wrappingKey, gcm(fromBase64(w.iv)), AES, extractable, usages)
}

async function deriveKek(password: string, kdf: Keyring['kdf']): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  const params: Pbkdf2Params = { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(kdf.salt), iterations: kdf.iterations }
  return crypto.subtle.deriveKey(params, base, AES, false, MASTER_USAGES)
}

function newKdf(iterations: number): Keyring['kdf'] {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(randomBytes(16)) }
}

/** 解析服务器返回的密钥环；格式不符时抛错（不猜测、不兼容未知版本） */
export function parseKeyring(text: string): Keyring {
  const k = JSON.parse(text) as Keyring
  if (k?.v !== 1 || k.kdf?.name !== 'PBKDF2' || k.kdf.hash !== 'SHA-256' || !k.key?.iv || !k.key.data) {
    throw new Error('密钥环格式无法识别')
  }
  return k
}

/** 生成新的密钥环，返回它和已解开的主密钥（iterations 仅供测试缩短耗时） */
export async function createKeyring(password: string, iterations = PBKDF2_ITERATIONS): Promise<{ keyring: Keyring; master: CryptoKey }> {
  const kdf = newKdf(iterations)
  const kek = await deriveKek(password, kdf)
  const extractable = await crypto.subtle.generateKey(AES, true, MASTER_USAGES)
  const keyring: Keyring = { v: 1, kdf, key: await wrap(extractable, kek) }
  // 内存中只保留不可导出的副本
  return { keyring, master: await unwrap(keyring.key, kek, MASTER_USAGES) }
}

/** 用加密密码解开主密钥；密码错误时抛出 WrongPasswordError */
export async function unlockKeyring(keyring: Keyring, password: string): Promise<CryptoKey> {
  const kek = await deriveKek(password, keyring.kdf)
  try {
    return await unwrap(keyring.key, kek, MASTER_USAGES)
  } catch (err) {
    throw isAuthFailure(err) ? new WrongPasswordError() : err
  }
}

/** 修改加密密码：主密钥不变，只用新密码重新包裹，已加密的笔记无需改动 */
export async function rewrapKeyring(keyring: Keyring, oldPassword: string, newPassword: string, iterations = PBKDF2_ITERATIONS): Promise<Keyring> {
  const oldKek = await deriveKek(oldPassword, keyring.kdf)
  let master: CryptoKey
  try {
    master = await unwrap(keyring.key, oldKek, MASTER_USAGES, true)
  } catch (err) {
    throw isAuthFailure(err) ? new WrongPasswordError() : err
  }
  const kdf = newKdf(iterations)
  return { v: 1, kdf, key: await wrap(master, await deriveKek(newPassword, kdf)) }
}

export async function newNoteKey(master: CryptoKey): Promise<NoteKey> {
  const key = await crypto.subtle.generateKey(AES, true, DATA_USAGES)
  return { key, wrapped: await wrap(key, master) }
}

export async function encryptNote(nk: NoteKey, text: string): Promise<string> {
  const iv = randomBytes(IV_BYTES)
  const data = await crypto.subtle.encrypt(gcm(iv), nk.key, encoder.encode(text))
  const env: NoteEnvelope = { v: 1, key: nk.wrapped, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
  return JSON.stringify(env)
}

/** 解密笔记，同时返回笔记密钥供之后保存时使用 */
export async function decryptNote(master: CryptoKey, file: string): Promise<{ text: string; key: NoteKey }> {
  let env: NoteEnvelope
  try {
    env = JSON.parse(file) as NoteEnvelope
  } catch {
    throw new Error('加密笔记格式无效')
  }
  if (env?.v !== 1 || !env.key || !env.iv || typeof env.data !== 'string') throw new Error('加密笔记格式无效')
  try {
    const key = await unwrap(env.key, master, DATA_USAGES)
    const text = decoder.decode(await crypto.subtle.decrypt(gcm(fromBase64(env.iv)), key, fromBase64(env.data)))
    return { text, key: { key, wrapped: env.key } }
  } catch (err) {
    throw isAuthFailure(err) ? new Error('解密失败：文件已损坏或不是用当前密钥加密的') : err
  }
}

// 加密图片为二进制（避免 base64 膨胀）：文件头 | 密钥 iv | 包裹的密钥 | 内容 iv | 密文。
// 服务器只保存为 .enc，原始类型（如 image/png）放在明文开头：1 字节长度 + 类型
export async function encryptAsset(master: CryptoKey, bytes: ArrayBuffer, type: string): Promise<Uint8Array<ArrayBuffer>> {
  const mime = encoder.encode(type)
  if (mime.length > 255) throw new Error('图片类型过长')
  const key = await crypto.subtle.generateKey(AES, true, DATA_USAGES)
  const keyIv = randomBytes(IV_BYTES)
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', key, master, gcm(keyIv)))
  const plain = new Uint8Array(1 + mime.length + bytes.byteLength)
  plain[0] = mime.length
  plain.set(mime, 1)
  plain.set(new Uint8Array(bytes), 1 + mime.length)
  const iv = randomBytes(IV_BYTES)
  const cipher = new Uint8Array(await crypto.subtle.encrypt(gcm(iv), key, plain))
  const out = new Uint8Array(ASSET_MAGIC.length + IV_BYTES + WRAPPED_KEY_BYTES + IV_BYTES + cipher.length)
  let at = 0
  for (const part of [ASSET_MAGIC, keyIv, wrapped, iv, cipher]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export async function decryptAsset(master: CryptoKey, file: ArrayBuffer): Promise<Blob> {
  const bytes = new Uint8Array(file)
  const header = ASSET_MAGIC.length + IV_BYTES + WRAPPED_KEY_BYTES + IV_BYTES
  if (bytes.length < header || ASSET_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('加密图片格式无效')
  let at = ASSET_MAGIC.length
  const take = (n: number) => bytes.slice(at, (at += n))
  const keyIv = take(IV_BYTES)
  const wrapped = take(WRAPPED_KEY_BYTES)
  const iv = take(IV_BYTES)
  try {
    const key = await crypto.subtle.unwrapKey('raw', wrapped, master, gcm(keyIv), AES, false, DATA_USAGES)
    const plain = new Uint8Array(await crypto.subtle.decrypt(gcm(iv), key, bytes.subarray(at)))
    const type = decoder.decode(plain.subarray(1, 1 + plain[0]))
    return new Blob([plain.subarray(1 + plain[0])], { type })
  } catch (err) {
    throw isAuthFailure(err) ? new Error('解密失败：图片已损坏或不是用当前密钥加密的') : err
  }
}
