import { t as translate } from '@@/i18n/runtime'
/* eslint-disable no-control-regex -- Pasted links must detect and remove control characters in schemes. */
import TurndownService from 'turndown'

export async function htmlToMarkdown(html: string, importImage: (url: string) => Promise<string>, onError: (error: unknown) => void): Promise<string> {
  // Keep external resources and scripts inert inside template; clipboard HTML must not enter the active page.
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content
  const base = fragment.querySelector('base[href]')?.getAttribute('href')
  fragment.querySelectorAll('script,style,iframe,object,embed,template,meta,link,base').forEach(node => node.remove())
  if (base) {
    for (const node of fragment.querySelectorAll('a[href],img[src]')) {
      const attribute = node.tagName === 'A' ? 'href' : 'src'
      try {
        node.setAttribute(attribute, new URL(node.getAttribute(attribute)!, base).href)
      } catch (error) {
        onError(new Error(translate('workspace.invalid_source_base_url_original_f0ec05'), { cause: error }))
      }
    }
  }

  const images = new Map<string, HTMLImageElement[]>()
  for (const image of fragment.querySelectorAll('img')) {
    let src = image.getAttribute('src') ?? ''
    if (src.startsWith('//')) {
      src = `https:${src}`; image.setAttribute('src', src)
    }
    if (!/^https?:\/\//i.test(src)) continue
    const group = images.get(src) ?? []
    group.push(image)
    images.set(src, group)
  }
  const sources = [...images]
  // Web pages often contain many images; bound concurrency so one paste cannot exhaust browser connections or server download memory.
  for (let offset = 0; offset < sources.length; offset += 3) {
    await Promise.all(sources.slice(offset, offset + 3).map(async ([src, nodes]) => {
      try {
        const link = await importImage(src)
        for (const node of nodes) node.setAttribute('src', link)
      } catch (error) {
        onError(error)
      }
    }))
  }

  const service = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' })
  service.addRule('strikethrough', { filter: node => ['DEL', 'S', 'STRIKE'].includes(node.tagName), replacement: content => `~~${content}~~` })
  service.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const rows = [...node.querySelectorAll('tr')].filter(row => row.closest('table') === node).map(row =>
        [...row.cells].map(cell =>
          service.turndown(cell).replace(/\|/g, '\\|').replace(/\n+/g, ' '),
        ),
      )
      if (!rows.length) return ''
      const columns = Math.max(...rows.map(row => row.length))
      if (!columns) return ''
      const line = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? '').join(' | ')} |`
      return `\n\n${[line(rows[0]), line(Array.from<string>({ length: columns }).fill('---')), ...rows.slice(1).map(line)].join('\n')}\n\n`
    },
  })
  // Wrap destinations in angle brackets so URL parentheses do not truncate Markdown; discard executable schemes.
  service.addRule('link', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') ?? ''
      return href && !/^[\u0000-\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*(?:javascript|vbscript|data|file):/i.test(href.replace(/[\u0000-\u0020]/g, ''))
        ? `[${content}](<${href.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`
        : content
    },
  })
  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src') ?? ''
      const alt = (node.getAttribute('alt') ?? '').replace(/[[\]\\]/g, '\\$&').replace(/\n/g, ' ')
      return src && !/^(?:javascript|vbscript|file):/i.test(src.replace(/[\u0000-\u0020]/g, ''))
        ? `![${alt}](<${src.replace(/</g, '%3C').replace(/>/g, '%3E')}>)`
        : alt
    },
  })
  return service.turndown(fragment)
}
