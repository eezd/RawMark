export interface NoteMetadata { path: string, rev: string, title: string, tags: string[], links: { target: string, line: number }[], assets: { target: string, line: number }[], warnings: string[] }
export type MetadataResponseData = ApiResponseData<{ notes: NoteMetadata[], ready: boolean }>
