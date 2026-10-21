// 适配用户提供的 Obsidian CodeBlock.css：编辑器与分享页共用深色代码配色。
export const codeTheme = {
  name: 'rawmark-code',
  type: 'dark' as const,
  colors: { 'editor.background': '#263238', 'editor.foreground': '#abb2bf' },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#8f9094', fontStyle: 'italic' } },
    { scope: ['keyword', 'storage'], settings: { foreground: '#c678dd' } },
    { scope: ['keyword.operator'], settings: { foreground: '#56b6c2' } },
    { scope: ['string', 'constant.other.symbol'], settings: { foreground: '#98c379' } },
    { scope: ['constant.numeric', 'constant.language', 'support.constant'], settings: { foreground: '#d19a66' } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#d19a66' } },
    { scope: ['entity.name.tag', 'variable.other.property', 'support.type.property-name'], settings: { foreground: '#e06c75' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#e5c07b' } },
    { scope: ['variable', 'punctuation'], settings: { foreground: '#abb2bf' } },
    { scope: ['variable.other.property'], settings: { foreground: '#e06c75' } },
  ],
}
