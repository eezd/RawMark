// 快速切换的模糊匹配。目标形如"目录/标题"，空白分隔的每个词都要命中；
// 连续命中标题 > 连续命中目录 > 按顺序零散命中（如用首字母找笔记）

export interface FuzzyMatch {
  score: number
  // 命中字符在目标中的下标，用于高亮
  positions: number[]
}

const BOUNDARY = new Set(['/', ' ', '-', '_', '.'])

function isBoundary(target: string, i: number): boolean {
  return i === 0 || BOUNDARY.has(target[i - 1])
}

function matchTerm(term: string, target: string, lower: string, titleStart: number): FuzzyMatch | null {
  // 取最后一处连续命中：标题在末尾，优先落在标题上
  const at = lower.lastIndexOf(term)
  if (at >= 0) {
    let score = at >= titleStart ? 100 : 50
    if (at === titleStart) score += 30
    else if (isBoundary(target, at)) score += 10
    return { score, positions: Array.from(term, (_, k) => at + k) }
  }
  const positions: number[] = []
  let from = 0
  for (const ch of term) {
    const i = lower.indexOf(ch, from)
    if (i < 0) return null
    positions.push(i)
    from = i + 1
  }
  // 越分散得分越低，命中词首的字符加分
  const spread = positions[positions.length - 1] - positions[0] + 1 - positions.length
  const boundaries = positions.filter((i) => isBoundary(target, i)).length
  return { score: Math.max(1, 20 - spread + boundaries * 3), positions }
}

/** titleStart 为标题在 target 中的起始下标；不匹配时返回 null */
export function fuzzyMatch(query: string, target: string, titleStart: number): FuzzyMatch | null {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return null
  const lower = target.toLowerCase()
  let score = 0
  const positions = new Set<number>()
  for (const term of terms) {
    const m = matchTerm(term, target, lower, titleStart)
    if (!m) return null
    score += m.score
    m.positions.forEach((p) => positions.add(p))
  }
  // 标题与输入完全一致时排在最前
  if (lower.slice(titleStart) === query.trim().toLowerCase()) score += 1000
  return { score, positions: [...positions].sort((a, b) => a - b) }
}

/** 按命中与否把文本切成连续片段，用于高亮 */
export function segments(text: string, hits: Set<number>) {
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i)
    const last = out[out.length - 1]
    if (last?.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}
