import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface PasteImagesOptions {
  // 上传文件，返回写入 Markdown 的链接
  upload: (file: File) => Promise<string>
  onError: (err: unknown) => void
  // 上传开始/结束，供保存队列在上传期间暂缓保存（避免把临时的 blob: 地址写入文件）
  onPending: (delta: 1 | -1) => void
}

// 粘贴或拖入图片：先用 blob: 地址插入占位，立即显示；上传完成后替换为正式链接
export function pasteImages(opts: PasteImagesOptions): Extension {
  const insert = (view: EditorView, files: File[], pos?: number) => {
    const images = files.filter((f) => f.type.startsWith('image/'))
    if (!images.length) return false
    const urls = images.map((f) => URL.createObjectURL(f))
    const text = urls.map((u) => `![](${u})`).join('\n')
    const range = view.state.selection.main
    const from = pos ?? range.from
    const to = pos ?? range.to
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      userEvent: 'input.paste',
    })
    images.forEach((file, i) => {
      opts.onPending(1)
      opts
        .upload(file)
        .then((link) => replaceUrl(view, urls[i], link))
        .catch((err) => {
          removePlaceholder(view, urls[i])
          opts.onError(err)
        })
        .finally(() => {
          opts.onPending(-1)
          URL.revokeObjectURL(urls[i])
        })
    })
    return true
  }
  return EditorView.domEventHandlers({
    paste(e, view) {
      // 个别浏览器/来源只在 items 中提供图片
      let files = [...(e.clipboardData?.files ?? [])]
      if (!files.length) {
        files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f) => f !== null)
      }
      if (!insert(view, files)) return false
      e.preventDefault()
      return true
    },
    drop(e, view) {
      const files = [...(e.dataTransfer?.files ?? [])]
      const pos = view.posAtCoords(e)
      if (!files.length || !insert(view, files, pos ?? undefined)) return false
      e.preventDefault()
      return true
    },
  })
}

// 占位可能已被用户编辑移动，按 blob 地址在当前文档中查找
function replaceUrl(view: EditorView, url: string, link: string) {
  const at = view.state.doc.toString().indexOf(url)
  if (at >= 0) view.dispatch({ changes: { from: at, to: at + url.length, insert: link } })
}

function removePlaceholder(view: EditorView, url: string) {
  const placeholder = `![](${url})`
  const at = view.state.doc.toString().indexOf(placeholder)
  if (at >= 0) view.dispatch({ changes: { from: at, to: at + placeholder.length, insert: '' } })
}
