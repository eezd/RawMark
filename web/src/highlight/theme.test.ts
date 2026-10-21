import { expect, it } from 'vitest'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import { codeTheme } from './theme'

it('实际语法高亮使用参考片段的关键字、字符串和注释颜色', async () => {
  const language = await bundledLanguages.javascript()
  const highlighter = await createHighlighterCore({ themes: [codeTheme], langs: language.default, engine: createJavaScriptRegexEngine() })
  try {
    const tokens = highlighter.codeToTokensBase('const value = "hello" // comment', { lang: 'javascript', theme: codeTheme.name }).flat()
    expect(tokens.find((token) => token.content === 'const')?.color).toBe('#C678DD')
    expect(tokens.find((token) => token.content.includes('hello'))?.color).toBe('#98C379')
    expect(tokens.find((token) => token.content.includes('comment'))?.color).toBe('#8F9094')
  } finally { highlighter.dispose() }
})
