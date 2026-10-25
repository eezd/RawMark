import type { TrashItem } from '@@/apis/trash/type'
import type { TreeIcon } from '@@/apis/vault/type'
import type { ImportResult, NoteMetadata, SearchResult } from './type'
import { encodePath, requestJSON, requestRaw } from '@/http/axios'

export const workspaceApi = {
  importNotes: (dir: string, folder: string, files: File[]) => {
    const body = new FormData()
    body.append('dir', dir)
    body.append('folder', folder)
    for (const file of files) body.append('files', file)
    return requestJSON<ImportResult>('POST', '/import', { errorOwner: 'caller', body })
  },
  exportFiles: (paths: string[]) => requestRaw('POST', '/export', { errorOwner: 'caller', json: { paths } }),
  metadata: () => requestJSON<{ notes: NoteMetadata[], ready: boolean }>('GET', '/metadata', { errorOwner: 'caller' }),
  setTreeIcon: (path: string, icon: TreeIcon | null) => requestJSON('PUT', '/tree-icon', { errorOwner: 'caller', json: { path, icon } }),
  search: async (q: string) => (await requestJSON<{ results: SearchResult[] }>('GET', `/search?q=${encodeURIComponent(q)}`, { errorOwner: 'caller' })).results,
  async writeFile(path: string, content: string, ifMatch?: string, keepalive = false): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'text/markdown; charset=utf-8' }
    if (ifMatch === '') headers['If-None-Match'] = '*'
    else if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`
    const res = await requestJSON<{ rev: string }>('PUT', `/files/${encodePath(path)}`, { errorOwner: 'caller', body: content, headers, keepalive: keepalive && new Blob([content]).size < 60_000 })
    return res.rev
  },
  deleteFile: (path: string) => requestJSON<TrashItem>('DELETE', `/files/${encodePath(path)}`, { errorOwner: 'caller' }),
  move: (from: string, to: string) => requestJSON('POST', '/move', { errorOwner: 'caller', json: { from, to } }),
  mkdir: (path: string) => requestJSON('POST', '/folders', { errorOwner: 'caller', json: { path } }),
  async upload(note: string, file: File): Promise<string> {
    const form = new FormData()
    form.append('file', file, file.name || 'image')
    return (await requestJSON<{ link: string }>('POST', `/assets?note=${encodeURIComponent(note)}`, { errorOwner: 'caller', body: form })).link
  },
  cleanupImages: (paths: string[]) => requestJSON<{ deleted: TrashItem[], skipped: { path: string, reason: string }[] }>('POST', '/assets/cleanup', { errorOwner: 'caller', json: { paths } }),
  uploadFolderImage: async (folder: string, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return requestJSON<{ link: string }>('POST', `/assets?folder=${encodeURIComponent(folder)}`, { errorOwner: 'caller', body })
  },
  replaceImage: (path: string, file: File) => {
    const body = new FormData()
    body.append('file', file)
    return requestJSON('PUT', `/assets/${encodePath(path)}`, { errorOwner: 'caller', body })
  },
  importImage: async (note: string, url: string): Promise<string> =>
    (await requestJSON<{ link: string }>('POST', `/assets/import?note=${encodeURIComponent(note)}`, { errorOwner: 'caller', json: { url } })).link,
}
