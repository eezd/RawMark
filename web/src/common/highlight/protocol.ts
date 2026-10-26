// Message format between the main thread and highlight Worker.

export interface HighlightRequest {
  id: number
  lang: string
  code: string
}

// Preserve highlight.js nested tokens and source text; the editor uses official token-class styles.
export type TokenRun = (string | { classes: string, content: TokenRun })[]

// tokens is null for unsupported languages; actual failures must remain distinct from plain-text results.
export type HighlightResponse = { id: number, tokens: TokenRun | null } | { id: number, error: Error }
