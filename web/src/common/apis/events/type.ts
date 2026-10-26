export interface VaultEvent {
  type: 'tree' | 'changed' | 'deleted' | 'moved' | 'settings' | 'plugins' | 'indexed'
  path?: string
  from?: string
  rev?: string
}

export interface EventHandlers { onEvents: (events: VaultEvent[]) => void, onResync: () => void }
