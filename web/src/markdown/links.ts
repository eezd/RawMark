// 浏览器在呈现链接属性时会解码实体；源码操作也须按相同规则解析目标。
export function decodeLinkDestination(raw: string): string {
  const field = document.createElement('textarea')
  return raw.replace(/\\([!-/:-@[-`{-~])/g, '$1').replace(/&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/g, entity => {
    field.innerHTML = entity
    return field.value
  })
}
