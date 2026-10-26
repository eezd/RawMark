import { t as translate } from '@@/i18n/runtime'
// Keep content not yet saved to the server in IndexedDB for restoration on the next startup.

export interface Draft {
  path: string
  content: string
  // Server revision underlying local changes; an empty string for new files.
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
    transaction.onabort = () => reject(transaction.error ?? new Error(translate('workspace.local_draft_transaction_aborted_67d8fb')))
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
        // add aborts the whole transaction if a draft already exists at the destination, preserving other unsaved contents.
        for (const draft of moving) store.add({ ...draft, path: to + draft.path.slice(from.length) })
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(new Error(translate('workspace.could_not_migrate_the_local_3ac936'), { cause: transaction.error }))
    })
  },
}
