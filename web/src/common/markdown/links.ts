// Browsers decode entities in link attributes; source operations must resolve destinations using the same rules.
export function decodeLinkDestination(raw: string): string {
  const field = document.createElement('textarea')
  return raw.replace(/\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g, '$1').replace(/&(?:#\d{1,7}|#x[\da-f]{1,6}|[A-Z][A-Z\d]{1,31});/gi, (entity) => {
    field.innerHTML = entity
    return field.value
  })
}
