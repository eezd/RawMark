import type { Grammar, Token } from 'prismjs'
import components from 'prismjs/components.json'
import getLoader, { type ComponentCategory } from 'prismjs/dependencies'
import type { HighlightRequest, HighlightResponse, TokenRun } from './protocol'

// 复用应用自己的 Worker 协议，禁止 Prism 注册另一套消息处理器。
Object.assign(globalThis, { Prism: { manual: true, disableWorkerMessageHandler: true } })
const prismReady = import('prismjs').then((mod) => mod.default)
const imports = import.meta.glob(['../../node_modules/prismjs/components/prism-*.js', '!../../node_modules/prismjs/components/*.min.js', '!../../node_modules/prismjs/components/prism-core.js'])
const { meta, ...entries } = components.languages
const languages: ComponentCategory = entries
const aliases = new Map<string, string>()
for (const [id, entry] of Object.entries(languages)) {
  aliases.set(id, id)
  if (typeof entry !== 'string') {
    for (const alias of typeof entry.alias === 'string' ? [entry.alias] : entry.alias ?? []) aliases.set(alias, id)
  }
}

// Prism 默认包预载这四种基础语法，确保 HTML 的样式和脚本嵌套高亮不依赖请求顺序。
const loaded = new Set(['markup', 'css', 'clike', 'javascript'])
let loadTail = Promise.resolve()

function loadLanguage(id: string): Promise<void> {
  const ready = loadTail.then(async () => {
    const wanted = new Set<string>()
    function include(lang: string) {
      if (wanted.has(lang) || loaded.has(lang)) return
      wanted.add(lang)
      const entry = languages[lang]
      if (typeof entry !== 'string') {
        // 首次加载时也包含可选嵌套语法，避免后续依赖 ESM 无法重复执行的组件。
        for (const refs of [entry.require, entry.optional, entry.modify]) {
          for (const dep of typeof refs === 'string' ? [refs] : refs ?? []) include(dep)
        }
      }
    }
    include(id)
    for (const lang of getLoader({ languages }, [...wanted]).getIds()) {
      if (loaded.has(lang)) continue
      await imports[`../../node_modules/prismjs/components/prism-${lang}.js`]()
      loaded.add(lang)
    }
  })
  // 语法组件修改共享注册表，按顺序加载；单次失败不能阻塞后续独立请求。
  loadTail = ready.catch(() => {})
  return ready
}

function serialize(content: string | Token | (string | Token)[]): TokenRun {
  return (Array.isArray(content) ? content : [content]).map((token) => {
    if (typeof token === 'string') return token
    const aliases = typeof token.alias === 'string' ? [token.alias] : token.alias ?? []
    return { classes: ['token', token.type, ...aliases].join(' '), content: serialize(token.content) }
  })
}

async function highlight(req: HighlightRequest): Promise<TokenRun | null> {
  const id = aliases.get(req.lang)
  if (!id) return null
  const prism = await prismReady
  await loadLanguage(id)
  const env: { code: string; grammar: Grammar; language: string; tokens?: (string | Token)[] } = { code: req.code, grammar: prism.languages[id], language: id }
  prism.hooks.run('before-tokenize', env)
  env.tokens = prism.tokenize(env.code, env.grammar)
  prism.hooks.run('after-tokenize', env)
  return serialize(env.tokens)
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
