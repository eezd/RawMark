// 主线程与高亮 Worker 之间的消息格式

export interface HighlightRequest {
  id: number
  lang: string
  code: string
}

// 保留 highlight.js 的嵌套 token 与原文，编辑器使用官方 token 类样式。
export type TokenRun = (string | { classes: string, content: TokenRun })[]

// 语言不受支持时 tokens 为 null；实际失败必须与纯文本结果区分。
export type HighlightResponse = { id: number, tokens: TokenRun | null } | { id: number, error: Error }
