import type { HighlightRequest, HighlightResponse, TokenRun } from './protocol'
import hljs from 'highlight.js'

// Convert only highlight.js-generated spans and escaped text; never insert HTML into the editor.
function serialize(html: string): TokenRun {
  const root: TokenRun = []
  const stack = [root]
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'' }
  for (const match of html.matchAll(/<span class="([^"]+)">|(<\/span>)|([^<]+)/g)) {
    if (match[1]) {
      const content: TokenRun = []
      stack[stack.length - 1].push({ classes: match[1], content })
      stack.push(content)
    } else if (match[2]) {
      stack.pop()
    } else {
      stack[stack.length - 1].push(match[3].replace(/&(?:amp|lt|gt|quot|#x27);/g, entity => entities[entity]))
    }
  }
  return root
}

function highlight(req: HighlightRequest): TokenRun | null {
  if (!hljs.getLanguage(req.lang)) return null
  const result = hljs.highlight(req.code, { language: req.lang, ignoreIllegals: true })
  // The library's safe mode may return an exception alongside plain text; propagate the actual failure.
  if (result.errorRaised) throw result.errorRaised
  return serialize(result.value)
}

globalThis.addEventListener('message', (e: MessageEvent<HighlightRequest>) => {
  let res: HighlightResponse
  try {
    res = { id: e.data.id, tokens: highlight(e.data) }
  } catch (cause) {
    res = { id: e.data.id, error: new Error('代码高亮失败', { cause }) }
  }
  globalThis.postMessage(res)
})
