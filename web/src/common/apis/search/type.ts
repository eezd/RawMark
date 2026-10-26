export interface SearchRequestData { q: string }
export interface SearchResult {
  path: string
  /** 第一处匹配行，从1开始；只有路径匹配时为0。 */
  line: number
  snippet: string
}
export type SearchResponseData = ApiResponseData<{ results: SearchResult[] }>
