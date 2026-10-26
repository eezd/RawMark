// Quick-switcher fuzzy matching targets "folder/title" and requires every whitespace-separated term to match.
// Rank contiguous title matches above contiguous folder matches, then ordered scattered matches such as initials.

export interface FuzzyMatch {
  score: number
  // Matched character indices in the target, for highlighting.
  positions: number[]
}

const BOUNDARY = new Set(['/', ' ', '-', '_', '.'])

function isBoundary(target: string, i: number): boolean {
  return i === 0 || BOUNDARY.has(target[i - 1])
}

function matchTerm(term: string, target: string, lower: string, titleStart: number): FuzzyMatch | null {
  // Use the last contiguous match: the title is at the end and takes priority.
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
  // Scattered matches score lower; word-initial matches receive a bonus.
  const spread = positions[positions.length - 1] - positions[0] + 1 - positions.length
  const boundaries = positions.filter(i => isBoundary(target, i)).length
  return { score: Math.max(1, 20 - spread + boundaries * 3), positions }
}

/** titleStart is the title's starting index in target; return null when unmatched. */
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
    m.positions.forEach(p => positions.add(p))
  }
  // Exact title/query matches rank first.
  if (lower.slice(titleStart) === query.trim().toLowerCase()) score += 1000
  return { score, positions: [...positions].sort((a, b) => a - b) }
}

/** Split text into contiguous matched/unmatched fragments for highlighting. */
export function segments(text: string, hits: Set<number>) {
  const out: { text: string, hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i)
    const last = out[out.length - 1]
    if (last?.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}
