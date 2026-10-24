import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { HighlightResponse, TokenRun } from './protocol'

const replies = new Map<number, HighlightResponse>()
const worker = new class extends EventTarget {
  postMessage(response: HighlightResponse) { replies.set(response.id, response) }
}()
let nextId = 1

beforeAll(async () => {
  vi.stubGlobal('self', worker)
  await import('./worker')
})
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function highlight(lang: string, code: string) {
  const id = nextId++
  worker.dispatchEvent(new MessageEvent('message', { data: { id, lang, code } }))
  await vi.waitFor(() => expect(replies.has(id)).toBe(true))
  const reply = replies.get(id)!
  if ('error' in reply) throw reply.error
  return reply.tokens
}
function text(tokens: TokenRun): string {
  return tokens.map((token) => typeof token === 'string' ? token : text(token.content)).join('')
}
function hasToken(tokens: TokenRun, classes: string, content: string): boolean {
  return tokens.some((token) => typeof token !== 'string' && ((token.classes === classes && text(token.content) === content) || hasToken(token.content, classes, content)))
}

it('首次高亮 HTML 就包含内嵌脚本和样式，不依赖其他代码块先加载语法', async () => {
  const source = '<script>const value = 1</script><style>a { color: red }</style>'
  const tokens = await highlight('html', source)
  expect(tokens).not.toBeNull()
  expect(text(tokens!)).toBe(source)
  expect(hasToken(tokens!, 'hljs-keyword', 'const')).toBe(true)
  expect(hasToken(tokens!, 'hljs-attribute', 'color')).toBe(true)
})

it('highlight.js token 保留原文、语言别名与嵌套语法，不再返回旧颜色', async () => {
  const source = 'const value = `中文😀 ${name}` // comment\n'
  const tokens = await highlight('js', source)
  expect(tokens).not.toBeNull()
  expect(text(tokens!)).toBe(source)
  expect(hasToken(tokens!, 'hljs-keyword', 'const')).toBe(true)
  expect(hasToken(tokens!, 'hljs-string', '`中文😀 ${name}`')).toBe(true)
  expect(hasToken(tokens!, 'hljs-subst', '${name}')).toBe(true)
  expect(hasToken(tokens!, 'hljs-comment', '// comment')).toBe(true)
  expect(await highlight('javascript', source)).toEqual(tokens)
})

it('并发请求和常见别名得到实际高亮', async () => {
  const samples = [
    ['python', 'print("hello")', 'hljs-string', '"hello"'],
    ['tsx', 'const App = () => <div title="hello">你好</div>', 'hljs-string', '"hello"'],
    ['sh', 'echo "$HOME"', 'hljs-variable', '$HOME'],
    ['yaml', 'name: hello', 'hljs-attr', 'name:'],
    ['json', '{"value": true}', 'hljs-keyword', 'true'],
    ['go', 'package main\nfunc main() {}', 'hljs-keyword', 'package'],
    ['php', '<?php echo $value; ?><div>中文😀</div>', 'hljs-keyword', 'echo'],
  ]
  await Promise.all(samples.map(async ([lang, source, classes, content]) => {
    const tokens = await highlight(lang, source)
    expect(tokens).not.toBeNull()
    expect(text(tokens!)).toBe(source)
    expect(hasToken(tokens!, classes, content), lang).toBe(true)
  }))
})

it('未知语言保持纯文本，真实分词失败返回原始原因且不阻断下一次请求', async () => {
  for (const lang of ['unknown-language', 'constructor', '__proto__']) expect(await highlight(lang, 'text')).toBeNull()
  const { default: hljs } = await import('highlight.js')
  const cause = new Error('分词失败')
  vi.spyOn(hljs, 'highlight').mockImplementationOnce(() => { throw cause })
  await expect(highlight('python', 'print(1)')).rejects.toMatchObject({ cause })
  expect(await highlight('python', 'print(1)')).not.toBeNull()
})

it('HTML 特殊字符、转义实体和伪造 span 原样保留，不作为标记解析', async () => {
  const source = `const value = "&lt; &amp; &quot; &#x27; <span class='hljs-keyword'>中文😀</span>"; // > & '\n`
  const tokens = await highlight('js', source)
  expect(text(tokens!)).toBe(source)
  expect(hasToken(tokens!, 'hljs-keyword', '中文😀')).toBe(false)
})

it('库安全模式返回的实际异常不伪装成成功的纯文本结果', async () => {
  const { default: hljs } = await import('highlight.js')
  const cause = new Error('语法运行失败')
  const original = hljs.highlight('value', { language: 'js' })
  vi.spyOn(hljs, 'highlight').mockReturnValueOnce({ ...original, errorRaised: cause })
  await expect(highlight('js', 'value')).rejects.toMatchObject({ cause })
})
