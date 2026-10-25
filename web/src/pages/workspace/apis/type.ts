export interface ImportResult {
  paths: string[]
  notes: number
  assets: number
  warnings: string[]
}

export interface NoteMetadata {
  path: string
  rev: string
  title: string
  tags: string[]
  links: { target: string, line: number }[]
  assets: { target: string, line: number }[]
  warnings: string[]
}

export interface SearchResult {
  path: string
  // 第一处匹配所在行（从 1 开始）及其摘录；只有路径匹配时 line 为 0
  line: number
  snippet: string
}
