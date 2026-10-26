export interface SearchRequestData { q: string }
export interface SearchResult {
  path: string
  /** First matching line, starting at 1; 0 when only the path matches. */
  line: number
  snippet: string
}
export type SearchResponseData = ApiResponseData<{ results: SearchResult[] }>
