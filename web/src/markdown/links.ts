import { markdownParser } from './html'

/** 图片地址在源码中的位置；url 为书写形式（尖括号已去掉，未解码） */
export interface ImageLink {
  from: number
  to: number
  url: string
}

/** 列出图片 ![](url) 与链接引用定义 [x]: url 中的地址（引用定义可能被图片使用）；代码中的不算 */
export function imageLinks(src: string): ImageLink[] {
  const out: ImageLink[] = []
  markdownParser.parse(src).iterate({
    enter(ref) {
      if (ref.name !== 'Image' && ref.name !== 'LinkReference') return
      const url = ref.node.getChild('URL')
      if (!url) return
      let { from, to } = url
      if (src[from] === '<' && src[to - 1] === '>') [from, to] = [from + 1, to - 1]
      out.push({ from, to, url: src.slice(from, to) })
    },
  })
  return out
}

/** 替换图片地址：map 返回 undefined 的保持不变 */
export function rewriteImageLinks(src: string, map: (url: string) => string | undefined): string {
  let out = ''
  let at = 0
  for (const l of imageLinks(src)) {
    const next = map(l.url)
    if (next === undefined) continue
    out += src.slice(at, l.from) + next
    at = l.to
  }
  return out + src.slice(at)
}
