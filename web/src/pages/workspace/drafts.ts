// 未成功保存到服务器的内容暂存在 IndexedDB，供下次启动时恢复

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
  const transaction = (await db()).transaction('drafts', mode)
  return new Promise((resolve, reject) => {
    const req = fn(transaction.objectStore('drafts'))
    transaction.oncomplete = () => resolve(req.result)
    transaction.onabort = () => reject(transaction.error ?? new Error('本地草稿事务已中止'))
    req.onerror = () => reject(req.error)
  })
}

export const drafts = {
  put: (d: Draft) => tx('readwrite', s => s.put(d)),
  delete: (path: string) => tx('readwrite', s => s.delete(path)),
  all: () => tx<Draft[]>('readonly', s => s.getAll()),
  async move(from: string, to: string): Promise<void> {
    const transaction = (await db()).transaction('drafts', 'readwrite')
    return new Promise((resolve, reject) => {
      const store = transaction.objectStore('drafts')
      const request: IDBRequest<Draft[]> = store.getAll()
      request.onsuccess = () => {
        const moving = request.result.filter(draft => draft.path === from || draft.path.startsWith(`${from}/`))
        for (const draft of moving) store.delete(draft.path)
        // add 遇到目标路径已有草稿时中止整个事务，不能覆盖另一份未保存内容。
        for (const draft of moving) store.add({ ...draft, path: to + draft.path.slice(from.length) })
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(new Error('迁移本地草稿事务失败', { cause: transaction.error }))
    })
  },
}
