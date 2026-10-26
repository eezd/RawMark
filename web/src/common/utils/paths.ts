export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export const NOTE_EXT = '.md'

export function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|apng|bmp|ico|tiff?)$/i.test(path)
}

export function inAssetDir(path: string): boolean {
  return path.split('/').some(part => part.endsWith('.assets'))
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
  return basename(path).replace(/\.md$/, '')
}

// Resolve note image sources to loadable URLs: preserve absolute URLs and resolve relative paths against the note folder through the raw-resource endpoint.
export function resolveAssetUrl(notePath: string, src: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('/') || src.startsWith('#')) return src
  const parts = dirname(notePath) ? dirname(notePath).split('/') : []
  for (const seg of src.split(/[?#]/)[0].split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      parts.pop()
    } else {
      let decoded = seg
      try {
        decoded = decodeURIComponent(seg)
      } catch {
        // Preserve invalid percent-escape sequences as written.
      }
      parts.push(decoded)
    }
  }
  return `/api/v1/raw/${encodePath(parts.join('/'))}`
}

// Hide shared and note-specific attachment folders from navigation without changing their read/write contracts.
export function hiddenAssetPath(path: string): boolean {
  return path.split('/').some(part => part === 'assets' || part.endsWith('.assets'))
}

export function imageInFolder(path: string, dir: string): boolean {
  if (!isImage(path) || (dir && !path.startsWith(`${dir}/`))) return false
  const relative = dir ? path.slice(dir.length + 1) : path
  if (!relative.includes('/')) return true
  const first = relative.split('/')[0]
  return first === 'assets' || first.endsWith('.assets')
}
