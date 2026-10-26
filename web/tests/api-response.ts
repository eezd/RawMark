/** 测试用真实 JSON 响应外壳。 */
export function apiSuccess<T>(data: T): ApiResponseData<T> {
  return { code: 0, data, message: '成功' }
}
