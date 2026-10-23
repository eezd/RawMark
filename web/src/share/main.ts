// 只读分享页（/s/{token}）：取回笔记内容，用与编辑器同一套解析器渲染为 HTML。不加载编辑器
import { copyText } from '../clipboard'
import { readingStats } from '../app/reading'
import { applyDisplaySettings, sanitizeDisplaySettings } from '../themes/typography'
import { requestTokens, type TokenRun } from '../highlight/client'
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

interface SharedCollection {
  collection: true
  title: string
  items: { id: number; title: string; exists: boolean; dir: boolean }[]
}

const root = document.getElementById('share')!
const token = decodeURIComponent(location.pathname.split('/')[2] ?? '')
const api = '/api/v1/public/shares/' + encodeURIComponent(token)
const selectedItem = new URL(location.href).searchParams.get('item')
const selectedPath = new URL(location.href).searchParams.get('path') ?? ''
const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')
function pageUrl(path: string, item: string | null = selectedItem) {
  const query = new URLSearchParams()
  if (item !== null) query.set('item', item)
  if (path) query.set('path', path)
  return location.pathname + (query.size ? '?' + query : '')
}
function downloadUrl() {
  const url = new URL(api + '/assets/' + encodePath(selectedPath), location.origin)
  url.searchParams.set('download', '1')
  if (selectedItem !== null) url.searchParams.set('item', selectedItem)
  return url.href
}

function message(text: string) {
  root.replaceChildren(Object.assign(document.createElement('p'), { className: 'rm-share-message', textContent: text }))
}

async function load() {
  let res: Response
  try {
    const query = new URLSearchParams()
    if (selectedPath) query.set('path', selectedPath)
    if (selectedItem !== null) query.set('item', selectedItem)
    res = await fetch(api + (query.size ? '?' + query : ''), { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    message('网络错误，请检查连接后刷新')
    return
  }
  if (res.ok) {
    const content = (await res.json()) as SharedNote | SharedDirectory | SharedFile | SharedCollection
    let appearanceError = false
    try {
      const response = await fetch(api + '/appearance', { cache: 'no-store' })
      if (!response.ok) throw new Error('读取外观失败')
      const appearance = await response.json() as Record<string, unknown>
      applyDisplaySettings(sanitizeDisplaySettings(appearance))
      applyAppearance(sanitizeAppearance(appearance), typeof appearance.themeCSS === 'string' ? appearance.themeCSS : '')
    } catch {
      appearanceError = true
    }
    if ('collection' in content) renderCollection(content)
    else if (content.dir) renderDirectory(content)
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
    message(selectedPath || selectedItem !== null ? '此文件或文件夹已不存在，或不在分享范围内' : '分享不存在、已过期或已被撤销')
    if (selectedPath || selectedItem !== null) root.prepend(navigation())
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
  nav.append(Object.assign(document.createElement('a'), { href: pageUrl('', null), textContent: '分享首页' }))
  if (selectedItem !== null) nav.append(' / ', Object.assign(document.createElement('a'), { href: pageUrl(''), textContent: '主体首页' }))
  const parts = selectedPath.split('/').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    nav.append(' / ', Object.assign(document.createElement('a'), { href: pageUrl(parts.slice(0, i + 1).join('/')), textContent: parts[i] }))
  }
  return nav
}

function renderCollection(collection: SharedCollection) {
  document.title = collection.title
  const heading = Object.assign(document.createElement('h1'), { textContent: collection.title })
  const list = document.createElement('ul')
  list.className = 'rm-share-files'
  for (const item of collection.items) {
    const row = document.createElement('li')
    row.append(item.exists
      ? Object.assign(document.createElement('a'), { href: pageUrl('', String(item.id)), textContent: item.title + (item.dir ? '/' : '') })
      : Object.assign(document.createElement('span'), { textContent: item.title + '（已不可用）' }))
    list.append(row)
  }
  root.replaceChildren(heading, list)
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
  const listing = document.createElement('section')
  listing.className = 'rm-share-listing'
  listing.append(navigation(), heading, list)
  root.replaceChildren(publicHeader(document.title), listing)
  if (!directory.entries.length) root.append(Object.assign(document.createElement('p'), { textContent: '此文件夹为空' }))
}

function action(text: string, title: string, run: () => void) {
  const button = Object.assign(document.createElement('button'), { type: 'button', textContent: text, title })
  button.addEventListener('click', run)
  return button
}

function publicHeader(title: string) {
  const bar = document.createElement('header')
  bar.className = 'rm-public-header'
  const brand = Object.assign(document.createElement('a'), { className: 'rm-public-brand', href: pageUrl('', null), textContent: 'RawMark' })
  const badge = Object.assign(document.createElement('span'), { className: 'rm-public-badge', textContent: '只读知识库' })
  const current = Object.assign(document.createElement('span'), { className: 'rm-public-current', textContent: title })
  const controls = document.createElement('div')
  controls.className = 'rm-public-actions'
  const toc = action('大纲', '显示 / 隐藏文章大纲', () => { const open = root.classList.toggle('toc-open'); toc.setAttribute('aria-expanded', String(open)) })
  toc.className = 'rm-reading-action rm-toc-toggle'
  toc.setAttribute('aria-expanded', 'false')
  const focus = action('专注', '专注阅读', () => { const on = root.classList.toggle('rm-share-focus'); focus.setAttribute('aria-pressed', String(on)); focus.textContent = on ? '退出专注' : '专注' })
  focus.className = 'rm-reading-action'
  focus.setAttribute('aria-pressed', 'false')
  const copy = action('复制链接', '复制当前分享链接', () => { void copyText(location.href).then(ok => { copy.textContent = ok ? '已复制' : '复制失败' }).catch(() => { copy.textContent = '复制失败' }) })
  controls.append(toc, focus, copy, action('打印', '打印文章', () => window.print()))
  bar.append(brand, badge, current, controls)
  return bar
}

let stopReading: (() => void) | undefined
function render(note: SharedNote) {
  stopReading?.()
  document.title = note.title
  const aside = document.createElement('aside')
  aside.className = 'rm-share-sidebar'
  const header = document.createElement('header')
  header.className = 'rm-share-header'
  const article = document.createElement('article')
  article.className = 'rm-share-content'
  // 安全模式：原始 HTML 被转义，危险协议的链接被过滤。
  article.innerHTML = renderMarkdown(note.content)
  const headings = buildToc(article)
  const first = article.firstElementChild
  const title = first?.tagName === 'H1' ? first.textContent ?? note.title : note.title.replace(/\.md$/, '')
  if (first?.tagName === 'H1') first.remove()
  const stats = readingStats(article.textContent ?? '')
  header.append(
    Object.assign(document.createElement('span'), { className: 'rm-share-kicker', textContent: 'PUBLIC NOTE · 公开分享' }),
    first?.tagName === 'H1' ? first : Object.assign(document.createElement('h1'), { textContent: title }),
    Object.assign(document.createElement('p'), { className: 'rm-share-time', textContent: `更新于 ${dateFormat.format(note.updatedAt)} · ${stats.words.toLocaleString('zh-CN')} 字词 · 预计阅读 ${stats.minutes} 分钟` }),
  )
  const surface = document.createElement('div')
  surface.className = 'rm-reading-card'
  const footer = Object.assign(document.createElement('footer'), { className: 'rm-reading-footer', textContent: '由 RawMark 分享 · 内容来自源文件的最新版本' })
  surface.append(header, article, footer)
  const layout = document.createElement('div')
  layout.className = 'rm-reading-layout'
  layout.append(aside, surface)
  root.replaceChildren(publicHeader(title), ...(selectedPath || selectedItem !== null ? [navigation()] : []), layout)
  const backdrop = action('', '关闭文章大纲', () => root.classList.remove('toc-open'))
  backdrop.className = 'rm-share-sidebar-backdrop'
  root.append(backdrop)
  resolveImages(surface)
  resolveLinks(surface)
  const toc = document.createElement('nav')
  toc.className = 'rm-public-toc'
  toc.setAttribute('aria-label', '文章大纲')
  toc.append(Object.assign(document.createElement('h2'), { textContent: '文章大纲' }))
  const min = Math.min(...headings.map(h => Number(h.tagName[1])))
  for (const heading of headings) {
    const link = Object.assign(document.createElement('a'), { href: '#' + heading.id, textContent: heading.textContent })
    link.style.paddingLeft = (Number(heading.tagName[1]) - min) * 14 + 12 + 'px'
    link.addEventListener('click', () => root.classList.remove('toc-open'))
    toc.append(link)
  }
  if (!headings.length) toc.append(Object.assign(document.createElement('p'), { textContent: '此文章没有小标题' }))
  const progressLabel = Object.assign(document.createElement('div'), { className: 'rm-reading-progress-label' })
  const progress = document.createElement('progress'); progress.max = 100; progress.value = 0
  progress.setAttribute('aria-label', '阅读进度')
  toc.append(progressLabel, progress)
  aside.append(toc)
  const hint = Object.assign(document.createElement('p'), { className: 'rm-reading-hint', textContent: '当前内容为只读分享，修改由知识库作者在源文件中完成。' })
  aside.append(hint)
  void sharedNavigation(aside)
  hydrate(surface)
  for (const code of article.querySelectorAll<HTMLElement>('pre > code')) void decorateCode(code).catch(error => {
    code.title = '代码高亮失败，已保留源码'
    console.error('分享页代码高亮失败', error)
  })
  let frame = 0
  function update() {
    frame = 0
    const rect = surface.getBoundingClientRect()
    const value = Math.round(Math.max(0, Math.min(100, (innerHeight - rect.top) / Math.max(1, rect.height) * 100)))
    progress.value = value
    progressLabel.textContent = '阅读进度 · ' + value + '%'
    let active = headings[0]
    for (const heading of headings) { if (heading.getBoundingClientRect().top < 160) active = heading }
    for (const link of toc.querySelectorAll('a')) { const on = link.getAttribute('href') === '#' + active?.id; link.classList.toggle('on', on); if (on) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current') }
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  const observer = new ResizeObserver(schedule)
  observer.observe(surface)
  stopReading = () => { observer.disconnect(); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame) }
  schedule()
  if (location.hash) {
    try { const id = decodeURIComponent(location.hash.slice(1)); requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView()) }
    catch { root.append(Object.assign(document.createElement('p'), { className: 'rm-share-error', textContent: '链接锚点编码无效' })) }
  }
}

// 目录导航只读取当前分享主体，不请求登录后的仓库元数据。
async function sharedNavigation(aside: HTMLElement) {
  if (!selectedPath) return
  try {
    const response = await fetch(api + (selectedItem !== null ? '?item=' + encodeURIComponent(selectedItem) : ''), { cache: 'no-store' })
    if (!response.ok) throw new Error(`读取分享目录失败（${response.status}）`)
    const directory = await response.json() as SharedNote | SharedDirectory
    if (!directory.dir) return
    const nav = document.createElement('nav')
    nav.className = 'rm-public-file-nav'
    nav.setAttribute('aria-label', '分享目录')
    nav.append(Object.assign(document.createElement('h2'), { textContent: directory.title }))
    for (const entry of directory.entries) {
      if (entry.path.split('/').some(part => part === 'assets' || part.endsWith('.assets')) || !entry.dir && !entry.path.endsWith('.md')) continue
      const link = Object.assign(document.createElement('a'), { href: pageUrl(entry.path), textContent: entry.path.split('/').at(-1) + (entry.dir ? '/' : '') })
      if (entry.path === selectedPath) link.className = 'on'
      nav.append(link)
    }
    aside.prepend(nav)
  } catch (error) { aside.append(Object.assign(document.createElement('p'), { className: 'rm-share-error', textContent: error instanceof Error ? error.message : '分享目录读取失败' })) }
}

// 相对引用始终经当前分享读取，范围由服务器按分享主体校验。
function resourceUrl(src: string): URL | null {
  try {
    const prefix = new URL(api + '/assets/', location.origin)
    const target = new URL(src, new URL(encodePath(selectedPath), prefix))
    if (selectedItem !== null) target.searchParams.set('item', selectedItem)
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
  const top = Math.min(...headings.map((h) => Number(h.tagName[1])))
  const list = document.createElement('ul')
  for (const h of headings) {
    const li = document.createElement('li')
    li.style.paddingLeft = `${(Number(h.tagName[1]) - top) * 1.2}em`
    li.append(Object.assign(document.createElement('a'), { href: '#' + h.id, textContent: h.textContent }))
    list.append(li)
  }
  for (const nav of navs) nav.replaceChildren(list.cloneNode(true))
  return headings
}

async function decorateCode(code: HTMLElement) {
  const lang = /language-(\S+)/.exec(code.className)?.[1]?.toLowerCase()
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
  const pre = code.parentElement!
  const tools = document.createElement('div'); tools.className = 'rm-public-code-tools'
  const copy = action('复制', '复制代码', () => { void copyText(text).then(ok => { copy.textContent = ok ? '已复制' : '复制失败' }).catch(() => { copy.textContent = '复制失败' }) })
  tools.append(Object.assign(document.createElement('span'), { textContent: lang || 'text' }), copy)
  pre.prepend(tools)
  if (!lang) return
  const run = await requestTokens(lang, text)
  if (!run) return
  const out = document.createDocumentFragment()
  function appendTokens(parent: DocumentFragment | HTMLElement, tokens: TokenRun) {
    for (const token of tokens) {
      if (typeof token === 'string') parent.append(token)
      else {
        const span = document.createElement('span')
        span.className = token.classes
        appendTokens(span, token.content)
        parent.append(span)
      }
    }
  }
  appendTokens(out, run)
  code.replaceChildren(out)
}

window.addEventListener('rawmark-appearance', () => {
  for (const el of root.querySelectorAll<HTMLElement>('.rm-share-mermaid')) {
    const code = el.dataset.code
    if (code !== undefined) void renderMermaid(code).then((svg) => { el.innerHTML = svg }).catch(() => { el.textContent = '图表渲染失败，请刷新重试' })
  }
})

window.addEventListener('keydown', event => { if (event.key === 'Escape') root.classList.remove('toc-open') })

void load()
