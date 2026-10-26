// Render math, Mermaid, and emoji. Load these large dependencies on first use as separate chunks.
import type { MermaidConfig } from 'mermaid'

let katexLoad: Promise<typeof import('katex').default> | undefined
function loadKatex() {
  katexLoad ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default)
  return katexLoad
}

/** Render math; display syntax errors in red instead of throwing. */
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

/** Render Mermaid to SVG markup; throw a descriptive Error for invalid syntax. */
async function renderDiagram(code: string): Promise<string> {
  const mermaid = await loadMermaid()
  const mode = document.documentElement.dataset.rmColorMode
  const dark = mode === 'dark' || (mode === undefined && matchMedia('(prefers-color-scheme: dark)').matches)
  // Serialize configuration and rendering so concurrent diagrams cannot read another mode's global configuration during a mode switch.
  const config: MermaidConfig = { startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' }
  mermaid.initialize(config)
  const id = `rm-mermaid-${++mermaidSeq}`
  try {
    return (await mermaid.render(id, code)).svg
  } catch (err) {
    // Mermaid leaves temporary nodes in body after errors.
    document.getElementById(`d${id}`)?.remove()
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

/** Look up emoji by GitHub/Typora names, such as smile -> smiling emoji; return undefined for unknown names. */
export async function emojiFor(name: string): Promise<string | undefined> {
  emojiLoad ??= import('gemoji').then(({ gemoji }) => {
    const map = new Map<string, string>()
    for (const g of gemoji) {
      for (const n of g.names) map.set(n, g.emoji)
    }
    return map
  })
  return (await emojiLoad).get(name)
}

/** Fill renderer placeholders, including table cells, with math and emoji. */
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
