// When software keyboards open, iOS Safari and recent Android Chrome shrink the visual viewport without changing page height,
// covering the editor bottom, cursor, and toolbar. Set application height to the visual viewport height.
// Pinch zoom also changes the visual viewport; do not resize while zooming.
export function trackVisualViewport(onShrink: () => void) {
  const vv = window.visualViewport
  if (!vv) return
  let last = vv.height
  const update = () => {
    const height = vv.scale > 1.01 ? null : vv.height
    document.documentElement.style.setProperty('--rm-app-height', height === null ? '100%' : `${height}px`)
    // iOS shifts the page to reveal the input; application height already accounts for the keyboard, so restore its position.
    if (height !== null && vv.offsetTop > 0) window.scrollTo(0, 0)
    if (height !== null && height < last) requestAnimationFrame(onShrink)
    last = vv.height
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
}
