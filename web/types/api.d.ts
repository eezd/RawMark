/** 普通 JSON 接口的统一响应；文件、下载、事件与 204 使用各自的 HTTP 语义。 */
interface ApiResponseData<T> {
  code: number
  data: T
  message: string
}
