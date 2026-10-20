// REST API 客户端，与服务端 internal/api 对应

export interface Entry {
  path: string
  dir: boolean
  size: number
  mtime: number
}

export interface Theme {
  id: string
  name: string
  version: string
}

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  apiVersion: 1
  revision: string
  enabled: boolean
}

export interface TrashItem {
  id: string
  path: string
  dir: boolean
  deletedAt: number
}

export interface SearchResult {
  path: string
  // 第一处匹配所在行（从 1 开始）及其摘录；只有路径匹配时 line 为 0
  line: number
  snippet: string
}

export interface Share {
  token: string
  path: string
  createdAt: number
  // 0 为永久
  expiresAt: number
  hasPassword: boolean
  // 分享的文件或文件夹是否仍存在
  exists: boolean
}

export interface ApiToken {
  id: string
  name: string
  scope: 'read' | 'write'
  createdAt: number
  // 0 为从未使用
  lastUsedAt: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

// 401 时通知应用回到登录页
let onUnauthorized: () => void = () => {}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn
}

export function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

async function request(
  method: string,
  url: string,
  init: { json?: unknown; body?: BodyInit; headers?: Record<string, string>; keepalive?: boolean } = {},
) {
  const headers: Record<string, string> = { ...init.headers }
  let body = init.body
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const res = await fetch(url, { method, headers, body, credentials: 'same-origin', cache: 'no-store', keepalive: init.keepalive })
  if (!res.ok) {
    let data: Record<string, unknown> = {}
    try {
      data = await res.json()
    } catch {
      // 非 JSON 错误体（如反向代理返回的页面）
    }
    if (res.status === 401 && !url.startsWith('/api/v1/auth/')) onUnauthorized()
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `请求失败（${res.status}）`, data)
  }
  return res
}

const json = async <T>(p: Promise<Response>): Promise<T> => (await p).json()

export const api = {
  authState: () => json<{ setUp: boolean; authenticated: boolean }>(request('GET', '/api/v1/auth/state')),
  setup: (code: string, password: string) => request('POST', '/api/v1/auth/setup', { json: { code, password } }),
  login: (password: string) => request('POST', '/api/v1/auth/login', { json: { password } }),
  logout: () => request('POST', '/api/v1/auth/logout'),

  changePassword: (current: string, next: string) => request('POST', '/api/v1/auth/password', { json: { current, next } }),

  settings: () => json<Record<string, unknown>>(request('GET', '/api/v1/settings')),
  themes: async () => (await json<{ themes: Theme[] }>(request('GET', '/api/v1/themes'))).themes,
  theme: (id: string) => json<Theme & { css: string }>(request('GET', '/api/v1/themes/' + encodeURIComponent(id))),
  plugins: async () => (await json<{ plugins: InstalledPlugin[] }>(request('GET', '/api/v1/plugins'))).plugins,
  installPlugin: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return json<InstalledPlugin>(request('POST', '/api/v1/plugins', { body }))
  },
  togglePlugin: (id: string, enabled: boolean) => json<InstalledPlugin>(request('PATCH', '/api/v1/plugins/' + encodeURIComponent(id), { json: { enabled } })),
  uninstallPlugin: (id: string) => request('DELETE', '/api/v1/plugins/' + encodeURIComponent(id)),
  pluginData: (id: string) => json<{ data: unknown }>(request('GET', '/api/v1/plugins/' + encodeURIComponent(id) + '/data')),
  savePluginData: (id: string, data: unknown) => request('PUT', '/api/v1/plugins/' + encodeURIComponent(id) + '/data', { json: { data } }),
  // 按顶层键合并，值为 null 的键被删除
  patchSettings: (patch: Record<string, unknown>) => json<Record<string, unknown>>(request('PATCH', '/api/v1/settings', { json: patch })),

  tree: async () => (await json<{ entries: Entry[] }>(request('GET', '/api/v1/tree'))).entries,
  search: async (q: string) => (await json<{ results: SearchResult[] }>(request('GET', '/api/v1/search?q=' + encodeURIComponent(q)))).results,

  async readFile(path: string): Promise<{ content: string; rev: string }> {
    const res = await request('GET', '/api/v1/files/' + encodePath(path))
    return { content: await res.text(), rev: (res.headers.get('ETag') ?? '').replace(/"/g, '') }
  },

  // ifMatch 为空字符串表示新建（文件必须不存在），undefined 表示无条件覆盖
  // keepalive 让请求在页面关闭后仍能发出（浏览器限制请求体不超过 64 KB，超出时退回普通请求）
  async writeFile(path: string, content: string, ifMatch?: string, keepalive = false): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'text/markdown; charset=utf-8' }
    if (ifMatch === '') headers['If-None-Match'] = '*'
    else if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`
    const res = request('PUT', '/api/v1/files/' + encodePath(path), {
      body: content,
      headers,
      keepalive: keepalive && new Blob([content]).size < 60_000,
    })
    return (await json<{ rev: string }>(res)).rev
  },

  deleteFile: (path: string) => json<TrashItem>(request('DELETE', '/api/v1/files/' + encodePath(path))),
  move: (from: string, to: string) => request('POST', '/api/v1/move', { json: { from, to } }),
  mkdir: (path: string) => request('POST', '/api/v1/folders', { json: { path } }),

  async upload(note: string, file: File): Promise<string> {
    const form = new FormData()
    form.append('file', file, file.name || 'image')
    return (await json<{ link: string }>(request('POST', '/api/v1/assets?note=' + encodeURIComponent(note), { body: form }))).link
  },

  shares: async (path?: string) =>
    (await json<{ shares: Share[] }>(request('GET', '/api/v1/shares' + (path ? '?path=' + encodeURIComponent(path) : '')))).shares,
  // expiresIn 为有效时长（秒），0 为永久
  createShare: (path: string, password: string, expiresIn: number) =>
    json<Share>(request('POST', '/api/v1/shares', { json: { path, password, expiresIn } })),
  deleteShare: (token: string) => request('DELETE', '/api/v1/shares/' + encodeURIComponent(token)),

  tokens: async () => (await json<{ tokens: ApiToken[] }>(request('GET', '/api/v1/tokens'))).tokens,
  // 返回的 token 明文只有这一次
  createToken: (name: string, scope: ApiToken['scope']) =>
    json<{ token: string; info: ApiToken }>(request('POST', '/api/v1/tokens', { json: { name, scope } })),
  deleteToken: (id: string) => request('DELETE', '/api/v1/tokens/' + encodeURIComponent(id)),

  trash: async () => (await json<{ items: TrashItem[] }>(request('GET', '/api/v1/trash'))).items,
  restore: (id: string) => json<TrashItem>(request('POST', `/api/v1/trash/${id}/restore`)),
  purge: (id: string) => request('DELETE', `/api/v1/trash/${id}`),
}
