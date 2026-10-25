// 软键盘弹出时，iOS Safari 与新版 Android Chrome 只缩小可视区域、页面高度不变，
// 编辑器底部（光标、键盘上方的工具条）会被键盘挡住。把应用高度设为可视区域的高度。
// 双指缩放也会改变可视区域，缩放时不调整
export function trackVisualViewport(onShrink: () => void) {
  const vv = window.visualViewport
  if (!vv) return
  let last = vv.height
  const update = () => {
    const height = vv.scale > 1.01 ? null : vv.height
    document.documentElement.style.setProperty('--rm-app-height', height === null ? '100%' : `${height}px`)
    // iOS 会把页面整体上推以露出输入位置，应用高度已经适配，推回原位
    if (height !== null && vv.offsetTop > 0) window.scrollTo(0, 0)
    if (height !== null && height < last) requestAnimationFrame(onShrink)
    last = vv.height
  }
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  update()
}
