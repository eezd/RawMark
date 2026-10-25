import type { MarkdownConfig } from '@lezer/markdown'
import { CODE_FONTS, TEXT_FONTS } from '../appearance/typography'

export const INLINE_FONTS = { ...TEXT_FONTS, mono: CODE_FONTS.jetbrains }
export const HOLLOW = '0.2px currentColor'
export const SHADOW = '1px 1px 2px currentColor'
export type InlineStyles = Partial<Record<'color' | 'background-color' | 'font-family' | 'font-size' | '-webkit-text-stroke' | '-webkit-text-fill-color' | 'text-shadow', string>>

/** 笔记是外部输入；仅允许工具栏实际生成的样式，不开放通用 HTML/CSS。 */
export function parseInlineStyles(value: string): InlineStyles | null {
  const result: InlineStyles = {}
  for (const declaration of value.split(';')) {
    if (!declaration.trim()) continue
    const colon = declaration.indexOf(':')
    if (colon < 0) return null
    const key = declaration.slice(0, colon).trim()
    const val = declaration.slice(colon + 1).trim()
    switch (key) {
      case 'color': case 'background-color':
        if (!/^#[\da-f]{6}$/i.test(val)) return null
        result[key] = val.toLowerCase(); break
      case 'font-family':
        if (!Object.values(INLINE_FONTS).some(font => font.css === val)) return null
        result[key] = val; break
      case 'font-size': {
        const match = /^(\d+(?:\.\d+)?)(px|em)$/.exec(val)
        if (!match || !(match[2] === 'px' ? +match[1] >= 9 && +match[1] <= 72 : +match[1] >= 0.56 && +match[1] <= 4.5)) return null
        result[key] = val; break
      }
      case '-webkit-text-stroke':
        if (val !== HOLLOW) return null
        result[key] = val; break
      case '-webkit-text-fill-color':
        if (val !== 'transparent') return null
        result[key] = val; break
      case 'text-shadow':
        if (val !== SHADOW) return null
        result[key] = val; break
      default: return null
    }
  }
  return Object.keys(result).length ? result : null
}

export function inlineStyleText(styles: InlineStyles): string {
  return Object.entries(styles).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}: ${value}`).join('; ')
}

export function stylesFromTag(tag: string): InlineStyles | null {
  const match = /^<span\s+style="([^"<>]*)"\s*>$/.exec(tag)
  return match ? parseInlineStyles(match[1]) : null
}

const underline = { resolve: 'Underline', mark: 'UnderlineMark' }
const appearance = { resolve: 'InlineStyle', mark: 'InlineStyleMark' }
export const inlineStyleSyntax: MarkdownConfig = {
  defineNodes: ['Underline', 'UnderlineMark', 'InlineStyle', 'InlineStyleMark'],
  parseInline: [{
    name: 'InlineAppearance',
    before: 'HTMLTag',
    parse(cx, next, pos) {
      if (next !== 60) return -1
      const tag = /^<[^<>\n]*>/.exec(cx.slice(pos, cx.end))?.[0]
      if (!tag) return -1
      if (tag === '<u>') return cx.addDelimiter(underline, pos, pos + tag.length, true, false)
      if (tag === '</u>') return cx.addDelimiter(underline, pos, pos + tag.length, false, true)
      if (stylesFromTag(tag)) return cx.addDelimiter(appearance, pos, pos + tag.length, true, false)
      if (tag === '</span>') return cx.addDelimiter(appearance, pos, pos + tag.length, false, true)
      return -1
    },
  }],
}
