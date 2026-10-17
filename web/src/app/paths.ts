import { encodePath } from './api'

export const NOTE_EXT = '.md'
export const ENCRYPTED_EXT = '.md.enc'

export function isEncrypted(path: string): boolean {
  return path.endsWith(ENCRYPTED_EXT)
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function noteTitle(path: string): string {
  return basename(path).replace(/\.md(\.enc)?$/, '')
}

/** 笔记的图片目录（Typora 风格，加密与未加密的同名笔记共用） */
export function assetsDirOf(notePath: string): string {
  return joinPath(dirname(notePath), noteTitle(notePath) + '.assets')
}

// 与服务端 vault.EscapeLinkPath 一致：只转义会破坏 Markdown 链接语法的字符
export function escapeLinkPath(s: string): string {
  return s.replace(/[ ()<>]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** 笔记中相对地址的图片在仓库中的路径；绝对地址、站内绝对路径与锚点返回 null */
export function assetPathOf(notePath: string, src: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) return null
  const parts = dirname(notePath) ? dirname(notePath).split('/') : []
  for (const seg of src.split(/[?#]/)[0].split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else {
      let decoded = seg
      try {
        decoded = decodeURIComponent(seg)
      } catch {
        // 非法的百分号序列按原样使用
      }
      parts.push(decoded)
    }
  }
  return parts.join('/')
}

// 把笔记中的图片地址解析为可加载的 URL：绝对地址原样返回，相对地址基于笔记所在目录走 /api/v1/raw
export function resolveAssetUrl(notePath: string, src: string): string {
  const p = assetPathOf(notePath, src)
  return p === null ? src : RAW_PREFIX + encodePath(p)
}

export const RAW_PREFIX = '/api/v1/raw/'
