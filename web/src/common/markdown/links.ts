// 浏览器在呈现链接属性时会解码实体；源码操作也须按相同规则解析目标。
export function decodeLinkDestination(raw: string): string {
  const field = document.createElement('textarea')
  return raw.replace(/\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g, '$1').replace(/&(?:#\d{1,7}|#x[\da-f]{1,6}|[A-Z][A-Z\d]{1,31});/gi, (entity) => {
    field.innerHTML = entity
    return field.value
  })
}
