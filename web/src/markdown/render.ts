// 数学公式、Mermaid 图表、emoji 的渲染。依赖体积较大，首次用到时才加载（各自打成独立的包）
import type { MermaidConfig } from 'mermaid'

let katexLoad: Promise<typeof import('katex').default> | undefined
function loadKatex() {
  katexLoad ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default)
  return katexLoad
}

/** 渲染公式；语法错误以红色显示错误信息而不是抛出 */
export async function renderMath(el: HTMLElement, tex: string, displayMode: boolean): Promise<void> {
  const katex = await loadKatex()
  katex.render(tex, el, { displayMode, throwOnError: false, output: 'htmlAndMathml' })
}

let mermaidLoad: Promise<typeof import('mermaid').default> | undefined
let mermaidSeq = 0
function loadMermaid() {
  mermaidLoad ??= import('mermaid').then(({ default: mermaid }) => mermaid)
  return mermaidLoad
}

/** 渲染 Mermaid 图表，返回 SVG 标记；语法错误时抛出带说明的 Error */
async function renderDiagram(code: string): Promise<string> {
  const mermaid = await loadMermaid()
  const mode = document.documentElement.dataset.rmColorMode
  const dark = mode === 'dark' || (mode === undefined && matchMedia('(prefers-color-scheme: dark)').matches)
  // 配置与渲染串行进行，避免切换模式时并发图表读到另一个模式的全局配置。
  const config: MermaidConfig = { startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' }
  mermaid.initialize(config)
  const id = `rm-mermaid-${++mermaidSeq}`
  try {
    return (await mermaid.render(id, code)).svg
  } catch (err) {
    // 出错时 mermaid 会把临时节点留在 body 中
    document.getElementById('d' + id)?.remove()
    throw err instanceof Error ? err : new Error(String(err))
  }
}

let renderQueue: Promise<unknown> = Promise.resolve()
export function renderMermaid(code: string): Promise<string> {
  const result = renderQueue.then(() => renderDiagram(code))
  renderQueue = result.catch(() => {})
  return result
}

let emojiLoad: Promise<Map<string, string>> | undefined

/** 按 GitHub/Typora 的名称查找 emoji，如 smile → 😄；未知名称返回 undefined */
export async function emojiFor(name: string): Promise<string | undefined> {
  emojiLoad ??= import('gemoji').then(({ gemoji }) => {
    const map = new Map<string, string>()
    for (const g of gemoji) for (const n of g.names) map.set(n, g.emoji)
    return map
  })
  return (await emojiLoad).get(name)
}

/** 为渲染器输出的占位元素（表格单元格等处）填充公式与 emoji */
export function hydrate(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('[data-math]')) {
    void renderMath(el, el.dataset.math!, el.tagName === 'DIV')
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-emoji]')) {
    void emojiFor(el.dataset.emoji!).then((e) => {
      if (e) el.textContent = e
    })
  }
}
