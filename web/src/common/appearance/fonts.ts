import type { CustomFont } from '@@/apis/fonts/type'
import { getFontsApi } from '@@/apis/fonts'
import { t as translate } from '@@/i18n/runtime'
import { fontResourceRoot, prepareResources } from '@@/utils/resource-tickets'

import { shallowRef } from 'vue'

export const customFonts = shallowRef<CustomFont[]>([])

export function applyFontCatalog(fonts: CustomFont[]) {
  customFonts.value = fonts
  let style = document.getElementById('rm-custom-fonts')
  if (!style) {
    style = document.createElement('style'); style.id = 'rm-custom-fonts'; document.head.append(style)
  }
  // Names are display-only; CSS identifiers and resource paths use only server-generated content hashes.
  const css = fonts.map(font => `@font-face { font-family: '${font.id}'; src: url('${fontResourceRoot()}${font.id}/file'); font-display: swap; }`).join('\n')
  if (style.textContent !== css) style.textContent = css
}

export function parseFontCatalog(value: unknown): CustomFont[] {
  if (!Array.isArray(value) || value.some(font => !font || typeof font !== 'object' || !/^custom-[a-f0-9]{64}$/.test(font.id) || typeof font.name !== 'string' || !['ttf', 'otf', 'woff', 'woff2'].includes(font.format))) throw new Error(translate('common.invalid_font_catalog_b577df'))
  return value
}

export async function loadFonts() {
  await prepareResources()
  applyFontCatalog(parseFontCatalog((await getFontsApi()).data.fonts))
}
