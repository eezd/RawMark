import { describe, expect, it } from 'vitest'
import {
  createKeyring,
  decryptAsset,
  decryptNote,
  encryptAsset,
  encryptNote,
  newNoteKey,
  parseKeyring,
  rewrapKeyring,
  unlockKeyring,
  WrongPasswordError,
} from './crypto'

// 测试中缩短 PBKDF2 迭代次数
const ITER = 1000

describe('密钥环', () => {
  it('正确密码解锁后能解密之前加密的笔记，错误密码报 WrongPasswordError', async () => {
    const { keyring, master } = await createKeyring('正确的密码', ITER)
    const stored = parseKeyring(JSON.stringify(keyring))
    const file = await encryptNote(await newNoteKey(master), '# 秘密\n内容')

    const unlocked = await unlockKeyring(stored, '正确的密码')
    expect((await decryptNote(unlocked, file)).text).toBe('# 秘密\n内容')
    await expect(unlockKeyring(stored, '错误的密码')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('主密钥不可导出', async () => {
    const { keyring, master } = await createKeyring('password', ITER)
    expect(master.extractable).toBe(false)
    expect((await unlockKeyring(keyring, 'password')).extractable).toBe(false)
  })

  it('修改密码后旧笔记仍可解密，旧密码失效', async () => {
    const { keyring, master } = await createKeyring('old-password', ITER)
    const file = await encryptNote(await newNoteKey(master), '内容')
    await expect(rewrapKeyring(keyring, '不对', 'new-password', ITER)).rejects.toBeInstanceOf(WrongPasswordError)

    const next = await rewrapKeyring(keyring, 'old-password', 'new-password', ITER)
    expect(next.kdf.salt).not.toBe(keyring.kdf.salt)
    expect((await decryptNote(await unlockKeyring(next, 'new-password'), file)).text).toBe('内容')
    await expect(unlockKeyring(next, 'old-password')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  it('拒绝无法识别的格式', () => {
    expect(() => parseKeyring('{"v":2}')).toThrow('密钥环格式无法识别')
    expect(() => parseKeyring('null')).toThrow('密钥环格式无法识别')
  })
})

describe('笔记', () => {
  it('同一笔记密钥多次加密：每次 iv 不同，密钥信封不变', async () => {
    const { master } = await createKeyring('password', ITER)
    const nk = await newNoteKey(master)
    const a = JSON.parse(await encryptNote(nk, 'x'))
    const b = JSON.parse(await encryptNote(nk, 'x'))
    expect(a.iv).not.toBe(b.iv)
    expect(a.key).toEqual(b.key)

    // 解密返回的密钥可继续用于保存
    const { key } = await decryptNote(master, JSON.stringify(a))
    expect((await decryptNote(master, await encryptNote(key, '新内容'))).text).toBe('新内容')
  })

  it('其他密钥环或被篡改的文件解密失败', async () => {
    const { master } = await createKeyring('password', ITER)
    const other = (await createKeyring('password', ITER)).master
    const file = await encryptNote(await newNoteKey(master), '内容')
    await expect(decryptNote(other, file)).rejects.toThrow('解密失败')

    const env = JSON.parse(file)
    env.data = env.data.slice(0, -4) + (env.data.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    await expect(decryptNote(master, JSON.stringify(env))).rejects.toThrow('解密失败')
    await expect(decryptNote(master, '明文')).rejects.toThrow('加密笔记格式无效')
    await expect(decryptNote(master, '{}')).rejects.toThrow('加密笔记格式无效')
  })

  it('空笔记与大笔记', async () => {
    const { master } = await createKeyring('password', ITER)
    const nk = await newNoteKey(master)
    const big = '中文内容 🙂\n'.repeat(100_000)
    for (const text of ['', big]) expect((await decryptNote(master, await encryptNote(nk, text))).text).toBe(text)
  })
})

describe('图片', () => {
  it('往返保留内容与类型', async () => {
    const { master } = await createKeyring('password', ITER)
    const bytes = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 256)
    const file = await encryptAsset(master, bytes.buffer, 'image/png')
    expect([...file.subarray(0, 4)]).toEqual([0x52, 0x4d, 0x45, 0x31])

    const blob = await decryptAsset(master, file.buffer)
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes)
  })

  it('错误密钥、篡改与非加密文件', async () => {
    const { master } = await createKeyring('password', ITER)
    const other = (await createKeyring('password', ITER)).master
    const file = await encryptAsset(master, new Uint8Array([1, 2, 3]).buffer, 'image/gif')
    await expect(decryptAsset(other, file.buffer)).rejects.toThrow('解密失败')
    file[file.length - 1] ^= 1
    await expect(decryptAsset(master, file.buffer)).rejects.toThrow('解密失败')
    await expect(decryptAsset(master, new TextEncoder().encode('\x89PNG plain image data, not encrypted at all......').buffer)).rejects.toThrow('格式无效')
  })
})
