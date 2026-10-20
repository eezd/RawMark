import TurndownService from 'turndown'

export async function htmlToMarkdown(html: string, importImage: (url: string) => Promise<string>, onError: (error: unknown) => void): Promise<string> {
  // template 中的外部资源和脚本保持惰性，不让剪贴板 HTML 进入活动页面。
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  const base = fragment.querySelector('base[href]')?.getAttribute('href')
  fragment.querySelectorAll('script,style,iframe,object,embed,template,meta,link,base').forEach((node) => node.remove())
  if (base) {
    for (const node of fragment.querySelectorAll('a[href],img[src]')) {
      const attribute = node.tagName === 'A' ? 'href' : 'src'
      try { node.setAttribute(attribute, new URL(node.getAttribute(attribute)!, base).href) }
      catch (error) { onError(new Error('来源基址无效，已保留原链接', { cause: error })) }
    }
  }

  const images = new Map<string, HTMLImageElement[]>()
  for (const image of fragment.querySelectorAll('img')) {
    let src = image.getAttribute('src') ?? ''
    if (src.startsWith('//')) { src = 'https:' + src; image.setAttribute('src', src) }
    if (!/^https?:\/\//i.test(src)) continue
    const group = images.get(src) ?? []
    group.push(image)
    images.set(src, group)
  }
  const sources = [...images]
  // 网页常有多张图片；限制并行数量，避免一次粘贴占满浏览器连接和服务端下载内存。
  for (let offset = 0; offset < sources.length; offset += 3) {
    await Promise.all(sources.slice(offset, offset + 3).map(async ([src, nodes]) => {
      try {
        const link = await importImage(src)
        for (const node of nodes) node.setAttribute('src', link)
      } catch (error) { onError(error) }
    }))
  }

  const service = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
  service.addRule('strikethrough', { filter: (node) => ['DEL', 'S', 'STRIKE'].includes(node.tagName), replacement: (content) => '~~' + content + '~~' })
  service.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = [...node.querySelectorAll('tr')].filter((row) => row.closest('table') === node).map((row) =>
        [...row.cells].map((cell) =>
          service.turndown(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' '),
        ),
      )
      if (!rows.length) return ''
      const columns = Math.max(...rows.map((row) => row.length))
      if (!columns) return ''
      const line = (cells: string[]) => '| ' + Array.from({ length: columns }, (_, index) => cells[index] ?? '').join(' | ') + ' |'
      return '\n\n' + [line(rows[0]), line(Array(columns).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n'
    },
  })
  // 链接目标用尖括号包裹，避免 URL 中的括号截断 Markdown；不保留可执行协议。
  service.addRule('link', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') ?? ''
      return href && !/^[\s\u0000-\u0020]*(?:javascript|vbscript|data|file):/i.test(href.replace(/[\u0000-\u0020]/g, ''))
        ? '[' + content + '](<' + href.replace(/</g, '%3C').replace(/>/g, '%3E') + '>)' : content
    },
  })
  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src') ?? ''
      const alt = (node.getAttribute('alt') ?? '').replace(/[\[\]\\]/g, '\\$&').replace(/\n/g, ' ')
      return src && !/^(?:javascript|vbscript|file):/i.test(src.replace(/[\u0000-\u0020]/g, ''))
        ? '![' + alt + '](<' + src.replace(/</g, '%3C').replace(/>/g, '%3E') + '>)' : alt
    },
  })
  return service.turndown(fragment)
}
