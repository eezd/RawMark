export interface Theme {
  id: string
  name: string
  version: string
}

export interface CustomFont {
  id: string
  name: string
  format: 'ttf' | 'otf' | 'woff' | 'woff2'
}
