// 只读分享页（/s/{token}）：取回笔记内容，用与编辑器同一套解析器渲染为 HTML。不加载编辑器
import { requestTokens } from '../highlight/client'
import { renderMarkdown } from '../markdown/html'
import { hydrate, renderMermaid } from '../markdown/render'
import { applyAppearance, sanitizeAppearance } from '../themes/appearance'
import '../themes/base.css'
import './share.css'

interface SharedNote {
  title: string
  content: string
  updatedAt: number
}

const root = document.getElementById('share')!
const token = decodeURIComponent(location.pathname.split('/')[2] ?? '')
const api = '/api/v1/public/shares/' + encodeURIComponent(token)

function message(text: string) {
  root.replaceChildren(Object.assign(document.createElement('p'), { className: 'rm-share-message', textContent: text }))
}

async function load() {
  let res: Response
  try {
    res = await fetch(api, { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    message('网络错误，请检查连接后刷新')
    return
  }
  if (res.ok) {
    const note = (await res.json()) as SharedNote
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
    render(note)
    if (appearanceError) root.prepend(Object.assign(document.createElement('p'), { className: 'rm-share-error', textContent: '外观加载失败，可刷新重试' }))
  }
  else if (res.status === 401) askPassword()
  else if (res.status === 404) message('分享不存在、已过期或已被撤销')
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
  root.replaceChildren(header, article)

  resolveImages(article)
  buildToc(article)
  hydrate(article)
  for (const code of article.querySelectorAll<HTMLElement>('pre > code')) void decorateCode(code).catch((error) => {
    code.title = '代码高亮失败，已保留源码'
    console.error('分享页代码高亮失败', error)
  })
}

// 相对地址的图片（笔记的 .assets）经分享接口读取；服务器只允许读取本篇的图片目录
function resolveImages(article: HTMLElement) {
  for (const img of article.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (src && !/^[a-z][a-z\d+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('#')) {
      img.src = api + '/assets/' + src.replace(/^(\.\/)+/, '')
    }
    img.loading = 'lazy'
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
