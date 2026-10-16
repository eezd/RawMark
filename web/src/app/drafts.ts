// 未成功保存到服务器的内容暂存在 IndexedDB，刷新页面或断网都不会丢失

export interface Draft {
  path: string
  content: string
  // 本地修改所基于的服务器版本；新建文件时为空字符串
  baseRev: string
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase> | undefined

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('rawmark', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'path' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const store = (await db()).transaction('drafts', mode).objectStore('drafts')
  return new Promise((resolve, reject) => {
    const req = fn(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const drafts = {
  put: (d: Draft) => tx('readwrite', (s) => s.put(d)),
  delete: (path: string) => tx('readwrite', (s) => s.delete(path)),
  all: () => tx<Draft[]>('readonly', (s) => s.getAll()),
}
