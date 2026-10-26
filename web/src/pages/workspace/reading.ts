// Count Chinese characters individually and other scripts as contiguous words; statistics do not change the original Markdown.
export function readingStats(text: string) {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const words = han + (text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+/gu)?.length ?? 0)
  return { words, characters: Array.from(text.replace(/\s/gu, '')).length, minutes: Math.ceil(words / 300) }
}
