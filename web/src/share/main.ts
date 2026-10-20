// 只读分享页（/s/{token}）：取回笔记内容，用与编辑器同一套解析器渲染为 HTML。不加载编辑器
import { requestTokens } from '../highlight/client'
import { renderMarkdown } from '../markdown/html'
import { hydrate, renderMermaid } from '../markdown/render'
import { applyAppearance, sanitizeAppearance } from '../themes/appearance'
import '../themes/base.css'
import './share.css'

interface SharedNote {
  title: string
  dir: false
  content: string
  updatedAt: number
}

interface SharedDirectory {
  title: string
  dir: true
  entries: { path: string; dir: boolean }[]
}

interface SharedFile {
  title: string
  dir: false
}

const root = document.getElementById('share')!
const token = decodeURIComponent(location.pathname.split('/')[2] ?? '')
const api = '/api/v1/public/shares/' + encodeURIComponent(token)
const selectedPath = new URL(location.href).searchParams.get('path') ?? ''
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
const pageUrl = (path: string) => location.pathname + (path ? '?path=' + encodeURIComponent(path) : '')
const downloadUrl = () => api + '/assets/' + encodePath(selectedPath) + '?download=1'

function message(text: string) {
  root.replaceChildren(Object.assign(document.createElement('p'), { className: 'rm-share-message', textContent: text }))
}

async function load() {
  let res: Response
  try {
    res = await fetch(api + (selectedPath ? '?path=' + encodeURIComponent(selectedPath) : ''), { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    message('网络错误，请检查连接后刷新')
    return
  }
  if (res.ok) {
    const content = (await res.json()) as SharedNote | SharedDirectory | SharedFile
    let appearanceError = false
    try {
      const response = await fetch(api + '/appearance', { cache: 'no-store' })
      if (!response.ok) throw new Error('读取外观失败')
      const appearance = await response.json() as Record<string, unknown>
      const rootStyle = document.documentElement.style
      if (typeof appearance.fontSize === 'number') rootStyle.setProperty('--rm-font-size', appearance.fontSize + 'px')
      if (typeof appearance.contentWidth === 'number') rootStyle.setProperty('--rm-content-width', appearance.contentWidth ? appearance.contentWidth + 'px' : 'none')
      applyAppearance(sanitizeAppearance(appearance), typeof appearance.themeCSS === 'string' ? appearance.themeCSS : '')
    } catch {
      appearanceError = true
    }
    if (content.dir) renderDirectory(content)
    else if ('content' in content) render(content)
    else {
      document.title = content.title
      const link = Object.assign(document.createElement('a'), { href: downloadUrl(), download: content.title, textContent: '下载 ' + content.title })
      root.replaceChildren(navigation(), link)
    }
    if (appearanceError) root.prepend(Object.assign(document.createElement('p'), { className: 'rm-share-error', textContent: '外观加载失败，可刷新重试' }))
  }
  else if (res.status === 401) askPassword()
  else if (res.status === 404) {
    message(selectedPath ? '此文件或文件夹已不存在，或不在分享范围内' : '分享不存在、已过期或已被撤销')
    if (selectedPath) root.prepend(navigation())
  }
  else message(`加载失败（${res.status}）`)
}

function askPassword(error = '') {
  const form = document.createElement('form')
  form.className = 'rm-share-password'
  form.innerHTML = `
    <p>这篇分享需要访问密码</p>
    <input type="password" autocomplete="current-password" required aria-label="访问密码" />
    <p class="rm-share-error"></p>
    <button type="submit">查看</button>`
  const input = form.querySelector('input')!
  const button = form.querySelector('button')!
  form.querySelector('.rm-share-error')!.textContent = error
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    button.disabled = true
    try {
      const res = await fetch(api + '/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      })
      if (res.ok) return void load()
      if (res.status === 404) return message('分享不存在、已过期或已被撤销')
      askPassword(res.status === 401 ? '密码错误' : res.status === 429 ? '尝试次数过多，请稍后再试' : `验证失败（${res.status}）`)
    } catch {
      askPassword('网络错误，请重试')
    }
  })
  root.replaceChildren(form)
  input.focus()
}

const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })

function navigation() {
  const nav = document.createElement('nav')
  nav.className = 'rm-share-nav'
  nav.setAttribute('aria-label', '分享导航')
  nav.append(Object.assign(document.createElement('a'), { href: pageUrl(''), textContent: '分享首页' }))
  const parts = selectedPath.split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    nav.append(' / ', Object.assign(document.createElement('a'), { href: pageUrl(parts.slice(0, i + 1).join('/')), textContent: parts[i] }))
  }
  return nav
}

function renderDirectory(directory: SharedDirectory) {
  document.title = directory.title
  const heading = Object.assign(document.createElement('h1'), { textContent: directory.title })
  const list = document.createElement('ul')
  list.className = 'rm-share-files'
  for (const entry of directory.entries) {
    const li = document.createElement('li')
    li.style.paddingLeft = (entry.path.split('/').length - 1) * 16 + 'px'
    const path = selectedPath ? selectedPath + '/' + entry.path : entry.path
    li.append(Object.assign(document.createElement('a'), { href: pageUrl(path), textContent: entry.path.split('/').at(-1) + (entry.dir ? '/' : '') }))
    list.append(li)
  }
  root.replaceChildren(navigation(), heading, list)
  if (!directory.entries.length) root.append(Object.assign(document.createElement('p'), { textContent: '此文件夹为空' }))
}

function render(note: SharedNote) {
  document.title = note.title
  const header = document.createElement('header')
  header.className = 'rm-share-header'
  header.append(
    Object.assign(document.createElement('span'), { className: 'rm-share-title', textContent: note.title }),
    Object.assign(document.createElement('span'), { className: 'rm-share-time', textContent: '更新于 ' + dateFormat.format(note.updatedAt) }),
  )
  const article = document.createElement('article')
  article.className = 'rm-share-content'
  // 安全模式：原始 HTML 被转义，危险协议的链接被过滤
  article.innerHTML = renderMarkdown(note.content)
  root.replaceChildren(...(selectedPath ? [navigation()] : []), header, article)

  resolveImages(article)
  resolveLinks(article)
  buildToc(article)
  hydrate(article)
  for (const code of article.querySelectorAll<HTMLElement>('pre > code')) void decorateCode(code).catch((error) => {
    code.title = '代码高亮失败，已保留源码'
    console.error('分享页代码高亮失败', error)
  })
}

// 相对引用始终经当前分享读取，范围由服务器按分享主体校验。
function resourceUrl(src: string): URL | null {
  try {
    const prefix = new URL(api + '/assets/', location.origin)
    const target = new URL(src, new URL(encodePath(selectedPath), prefix))
    return target.origin === prefix.origin && target.pathname.startsWith(prefix.pathname) ? target : null
  } catch { return null }
}

function resolveImages(article: HTMLElement) {
  for (const img of article.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (src && !/^[a-z][a-z\d+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('#')) {
      img.src = resourceUrl(src)?.href ?? '#'
    }
    img.loading = 'lazy'
  }
}

function resolveLinks(article: HTMLElement) {
  for (const link of article.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = link.getAttribute('href')!
    if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) continue
    const target = resourceUrl(href)
    if (!target) { link.href = '#'; continue }
    if (selectedPath) {
      try {
        const path = decodeURIComponent(target.pathname.slice((api + '/assets/').length)).replace(/\/$/, '')
        link.href = pageUrl(path) + target.hash
      } catch { link.href = '#' }
    } else {
      target.searchParams.set('download', '1')
      link.href = target.href
      link.download = ''
    }
  }
}

function buildToc(article: HTMLElement) {
  const headings = [...article.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')]
  const used = new Set<string>()
  for (const h of headings) {
    const base = (h.textContent ?? '').trim().toLowerCase().replace(/\s+/g, '-') || 'section'
    let id = base
    for (let i = 1; used.has(id) || document.getElementById(id); i++) id = `${base}-${i}`
    used.add(id)
    h.id = id
  }
  const navs = article.querySelectorAll('nav.toc')
  if (!navs.length) return
  const top = Math.min(...headings.map((h) => Number(h.tagName[1])))
  const list = document.createElement('ul')
  for (const h of headings) {
    const li = document.createElement('li')
    li.style.paddingLeft = `${(Number(h.tagName[1]) - top) * 1.2}em`
    li.append(Object.assign(document.createElement('a'), { href: '#' + h.id, textContent: h.textContent }))
    list.append(li)
  }
  for (const nav of navs) nav.replaceChildren(list.cloneNode(true))
}

async function decorateCode(code: HTMLElement) {
  const lang = /language-(\S+)/.exec(code.className)?.[1]?.toLowerCase()
  if (!lang) return
  const text = (code.textContent ?? '').replace(/\n$/, '')
  if (lang === 'mermaid') {
    const figure = document.createElement('div')
    figure.className = 'rm-share-mermaid'
    figure.dataset.code = text
    try {
      figure.innerHTML = await renderMermaid(text)
      code.parentElement!.replaceWith(figure)
    } catch {
      // 语法错误时保留源码
    }
    return
  }
  const run = await requestTokens(lang, text)
  if (!run) return
  const out = document.createDocumentFragment()
  let at = 0
  for (let i = 0; i < run.length; i += 4) {
    const from = run[i] as number
    const to = from + (run[i + 1] as number)
    if (from > at) out.append(text.slice(at, from))
    const span = document.createElement('span')
    const fontStyle = run[i + 3] as number
    if (run[i + 2]) span.style.color = run[i + 2] as string
    if (fontStyle & 1) span.style.fontStyle = 'italic'
    if (fontStyle & 2) span.style.fontWeight = 'bold'
    if (fontStyle & 4) span.style.textDecoration = 'underline'
    span.textContent = text.slice(from, to)
    out.append(span)
    at = to
  }
  out.append(text.slice(at))
  code.replaceChildren(out)
}

window.addEventListener('rawmark-appearance', () => {
  for (const el of root.querySelectorAll<HTMLElement>('.rm-share-mermaid')) {
    const code = el.dataset.code
    if (code !== undefined) void renderMermaid(code).then((svg) => { el.innerHTML = svg }).catch(() => { el.textContent = '图表渲染失败，请刷新重试' })
  }
})

void load()
