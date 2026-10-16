import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import githubDark from 'shiki/themes/github-dark.mjs'
import type { HighlightRequest, HighlightResponse, TokenRun } from './protocol'

const THEME = 'github-dark'

const highlighterReady: Promise<HighlighterCore> = createHighlighterCore({
  themes: [githubDark],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
})

// 同一语言的并发请求共用一次加载
const langLoads = new Map<string, Promise<boolean>>()

function ensureLanguage(hl: HighlighterCore, lang: string): Promise<boolean> {
  let load = langLoads.get(lang)
  if (!load) {
    const importer = bundledLanguages[lang as keyof typeof bundledLanguages]
    load = importer
      ? importer().then((mod) => hl.loadLanguage(mod.default)).then(() => true)
      : Promise.resolve(false)
    langLoads.set(lang, load)
  }
  return load
}

async function highlight(req: HighlightRequest): Promise<TokenRun | null> {
  const hl = await highlighterReady
  if (!(await ensureLanguage(hl, req.lang))) return null
  const run: TokenRun = []
  for (const line of hl.codeToTokensBase(req.code, { lang: req.lang, theme: THEME })) {
    for (const t of line) {
      if (!t.content.trim()) continue
      run.push(t.offset, t.content.length, t.color ?? '', t.fontStyle ?? 0)
    }
  }
  return run
}

self.addEventListener('message', async (e: MessageEvent<HighlightRequest>) => {
  const res: HighlightResponse = { id: e.data.id, tokens: await highlight(e.data) }
  ;(self as unknown as Worker).postMessage(res)
})
