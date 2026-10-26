/** Unified ordinary JSON response; files, downloads, events, and 204 retain their own HTTP semantics. */
interface ApiResponseData<T> {
  code: number
  data: T
  message: string
}
