import { t as translate } from '@@/i18n/runtime'
// Use the font set requested by actual browser layout, covering initial render, note switches, and later glyphs.
export function watchFontLoading() {
  const root = document.documentElement
  const fonts = document.fonts
  root.dataset.rmFonts = 'loading'

  function failed() {
    if (root.dataset.rmFonts === 'error') return
    root.dataset.rmFonts = 'error'
    const panel = document.createElement('div')
    panel.className = 'rm-font-error'
    panel.setAttribute('role', 'alert')
    const message = document.createElement('p')
    message.textContent = translate('common.fonts_could_not_be_loaded_42a574')
    const retry = document.createElement('button')
    retry.textContent = translate('common.refresh_page_9366e1')
    retry.addEventListener('click', () => location.reload())
    panel.append(message, retry)
    document.body.append(panel)
  }

  function ready() {
    if (root.dataset.rmFonts === 'error') return
    // fonts.ready also resolves after download failure; failure must not count as fonts being ready.
    if ([...fonts].some(font => font.status === 'error')) failed()
    else if (fonts.status === 'loaded') root.dataset.rmFonts = 'ready'
  }

  fonts.addEventListener('loading', () => {
    if (root.dataset.rmFonts === 'error') return
    root.dataset.rmFonts = 'loading'
    void fonts.ready.then(ready)
  })
  fonts.addEventListener('loadingerror', failed)

  // Trigger layout after mounting so the wait covers fonts used by the current text.
  requestAnimationFrame(() => {
    document.body.getBoundingClientRect()
    void fonts.ready.then(ready)
  })
}
