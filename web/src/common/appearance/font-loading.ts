import { t as translate } from '@@/i18n/runtime'
// 使用浏览器实际排版触发的字体集合，覆盖首屏、切换笔记与后来出现的字形。
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
    // fonts.ready 在下载失败时也会完成，不能将失败当作字体已就绪。
    if ([...fonts].some(font => font.status === 'error')) failed()
    else if (fonts.status === 'loaded') root.dataset.rmFonts = 'ready'
  }

  fonts.addEventListener('loading', () => {
    if (root.dataset.rmFonts === 'error') return
    root.dataset.rmFonts = 'loading'
    void fonts.ready.then(ready)
  })
  fonts.addEventListener('loadingerror', failed)

  // 挂载完成后触发一次排版，确保等待的是当前文字用到的字体。
  requestAnimationFrame(() => {
    document.body.getBoundingClientRect()
    void fonts.ready.then(ready)
  })
}
