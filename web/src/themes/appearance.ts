export interface CssSnippet {
  id: string
  name: string
  css: string
  enabled: boolean
}

export interface Appearance {
  colorMode: 'system' | 'light' | 'dark'
  theme: string
  cssSnippets: CssSnippet[]
}

export const appearancePaused = new URLSearchParams(location.search).has('reset-appearance')

export function fixedThemeMode(theme: string): 'light' | 'dark' | undefined {
  if (theme === 'white') return 'light'
  if (theme === 'black') return 'dark'
}

export function sanitizeAppearance(raw: Record<string, unknown>): Appearance {
  return {
    colorMode: raw.colorMode === 'light' || raw.colorMode === 'dark' ? raw.colorMode : 'system',
    theme: typeof raw.theme === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.theme) ? raw.theme : 'default',
    cssSnippets: Array.isArray(raw.cssSnippets) ? raw.cssSnippets.filter((s): s is CssSnippet =>
      s !== null && typeof s === 'object' && typeof s.id === 'string' && typeof s.name === 'string' &&
      typeof s.css === 'string' && typeof s.enabled === 'boolean',
    ).map((s) => ({ id: s.id, name: s.name, css: s.css, enabled: s.enabled })) : [],
  }
}

let current: Appearance = { colorMode: 'system', theme: 'default', cssSnippets: [] }
let themeCSS = ''
const darkMode = matchMedia('(prefers-color-scheme: dark)')
let rendered = ''

function style(id: string, css: string) {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.append(el)
  }
  if (el.textContent !== css) el.textContent = css
}

function render() {
  const mode = appearancePaused ? 'system' : fixedThemeMode(current.theme) ?? current.colorMode
  const dark = mode === 'system' ? darkMode.matches : mode === 'dark'
  const signature = JSON.stringify([dark, appearancePaused ? '' : [current.theme, themeCSS, current.cssSnippets]])
  if (signature === rendered) return
  rendered = signature
  const root = document.documentElement
  root.dataset.rmColorMode = dark ? 'dark' : 'light'
  root.dataset.rmTheme = appearancePaused ? 'default' : current.theme
  style('rm-theme', appearancePaused ? '' : themeCSS)
  // 独立样式元素避免某个片段的未闭合语法吞掉其他片段。
  document.querySelectorAll('style[data-rm-snippet]').forEach((el) => el.remove())
  if (!appearancePaused) for (const snippet of current.cssSnippets) {
    if (!snippet.enabled) continue
    const el = document.createElement('style')
    el.dataset.rmSnippet = snippet.id
    el.textContent = snippet.css
    document.head.append(el)
  }
  const bg = getComputedStyle(root).getPropertyValue('--rm-bg').trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.removeAttribute('media')
    meta.content = bg
  }
  window.dispatchEvent(new Event('rawmark-appearance'))
}

darkMode.addEventListener('change', render)

export function applyAppearance(next: Appearance, css: string) {
  current = next
  themeCSS = css
  render()
}
