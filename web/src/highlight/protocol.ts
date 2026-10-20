// 主线程与高亮 Worker 之间的消息格式

export interface HighlightRequest {
  id: number
  lang: string
  code: string
}

// 扁平数组：[offset, length, color, fontStyle, offset, length, ...]，避免大量小对象跨线程拷贝
export type TokenRun = (number | string)[]

// 语言不受支持时 tokens 为 null；实际失败必须与纯文本结果区分。
export type HighlightResponse = { id: number; tokens: TokenRun | null } | { id: number; error: Error }
