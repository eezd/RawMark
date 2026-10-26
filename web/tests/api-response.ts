/** Real JSON response envelope for tests. */
export function apiSuccess<T>(data: T): ApiResponseData<T> {
  return { code: 0, data, message: '成功' }
}
