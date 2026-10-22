// 中文按字、其他文字按连续词计数；界面统计不改变 Markdown 原文。
export function readingStats(text: string) {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const words = han + (text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0)
  return { words, characters: Array.from(text.replace(/\s/gu, '')).length, minutes: Math.ceil(words / 300) }
}
