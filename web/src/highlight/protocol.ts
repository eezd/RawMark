// 主线程与高亮 Worker 之间的消息格式

export interface HighlightRequest {
  id: number
  lang: string
  code: string
}

// 扁平数组：[offset, length, color, fontStyle, offset, length, ...]，避免大量小对象跨线程拷贝
export type TokenRun = (number | string)[]

export interface HighlightResponse {
  id: number
  // 语言不受支持时为 null，调用方按纯文本显示
  tokens: TokenRun | null
}
