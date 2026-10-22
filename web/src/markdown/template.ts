import { markdownParser } from './html'

export function localDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function renderTemplate(content: string, template: string, target: string, now = new Date()): string {
  const changes: { from: number; to: number; value: string }[] = []
  markdownParser.parse(content).iterate({ enter(node) {
    if (node.name !== 'URL' || !['Link', 'Image', 'LinkReference'].includes(node.node.parent?.name ?? '')) return
    const raw = content.slice(node.from, node.to).replace(/^<|>$/g, '')
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(raw)) return
    const url = new URL(raw.replace(/\\([!-/:-@[-`{-~])/g, '$1'), 'https://rawmark.local/' + template.split('/').map(encodeURIComponent).join('/'))
    const parts = decodeURIComponent(url.pathname.slice(1)).split('/')
    const base = target.slice(0, Math.max(0, target.lastIndexOf('/'))).split('/').filter(Boolean)
    while (base.length && base[0] === parts[0]) { base.shift(); parts.shift() }
    const relative = [...base.map(() => '..'), ...parts].map(part => encodeURIComponent(part)).join('/') + url.search + url.hash
    changes.push({ from: node.from, to: node.to, value: relative })
  } })
  for (const change of changes.reverse()) content = content.slice(0, change.from) + change.value + content.slice(change.to)
  const variables: Record<string, string> = { date: localDate(now), time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`, title: target.slice(target.lastIndexOf('/') + 1).replace(/\.md$/, '') }
  return content.replace(/\{\{(date|time|title)\}\}/g, (_, key: string) => variables[key])
}

