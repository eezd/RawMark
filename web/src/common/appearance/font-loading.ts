import { t as translate } from '@@/i18n/runtime'

const started = new WeakSet<FontFaceSet>()

// Fonts may finish after interaction starts; never hide or disable the application.
export function watchFontLoading() {
  const fonts = document.fonts
  if (started.has(fonts)) return
  started.add(fonts)
  let reported = false
  function failed() {
    if (reported) return
    reported = true
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
  fonts.addEventListener('loadingerror', failed)

  async function preload() {
    const regular = [...fonts].filter(face => face.family.replace(/['"]/g, '') === 'Maple Mono Normal NL NF CN' && face.style === 'normal' && face.weight === '400')
    for (let i = 0; i < regular.length; i += 2) {
      const results = await Promise.allSettled(regular.slice(i, i + 2).map(face => face.load()))
      if (results.some(result => result.status === 'rejected')) failed()
    }
  }
  // Yield a paint before scheduling background downloads, including in the standalone demo.
  requestAnimationFrame(() => {
    setTimeout(() => {
      if ([...fonts].some(face => face.status === 'error')) failed()
      void preload()
    }, 0)
  })
}
