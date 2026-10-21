import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import { codeTheme } from './theme'
import type { HighlightRequest, HighlightResponse, TokenRun } from './protocol'

const THEME = codeTheme.name

const highlighterReady: Promise<HighlighterCore> = createHighlighterCore({
  themes: [codeTheme],
  langs: [],
  engine: createJavaScriptRegexEngine({ forgiving: true }),
})

// 同一语言的并发请求共用一次加载
const langLoads = new Map<string, Promise<boolean>>()

function ensureLanguage(hl: HighlighterCore, lang: string): Promise<boolean> {
  let load = langLoads.get(lang)
  if (!load) {
    const importer = Object.hasOwn(bundledLanguages, lang) ? bundledLanguages[lang as keyof typeof bundledLanguages] : undefined
    load = importer
      ? importer().then((mod) => hl.loadLanguage(mod.default)).then(() => true).catch((error) => { langLoads.delete(lang); throw error })
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
  let res: HighlightResponse
  try {
    res = { id: e.data.id, tokens: await highlight(e.data) }
  } catch (cause) {
    res = { id: e.data.id, error: new Error('代码高亮失败', { cause }) }
  }
  self.postMessage(res)
})
