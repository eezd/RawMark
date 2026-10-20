import { Facet, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface PasteImagesOptions {
  // 上传文件，返回写入 Markdown 的链接
  upload: (file: File) => Promise<string>
  // 按笔记身份修改占位，上传结束时该笔记可能已切到后台
  replace: (text: string, replacement: string) => void
  onError: (err: unknown) => void
  // 上传开始/结束，供保存队列在上传期间暂缓保存（避免把临时的 blob: 地址写入文件）
  onPending: (delta: 1 | -1) => void
}

const uploadOptions = Facet.define<PasteImagesOptions, PasteImagesOptions | undefined>({ combine: (v) => v[0] })

/**
 * 插入图片文件（粘贴、拖入、从相册选择共用）：先用 blob: 地址插入占位，立即显示；上传完成后替换为正式链接。
 * 返回是否有图片被插入；编辑器未配置上传（pasteImages）时不处理
 */
export function insertImageFiles(view: EditorView, files: File[], pos?: number): boolean {
  const opts = view.state.facet(uploadOptions)
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (!opts || !images.length) return false
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
      .then((link) => opts.replace(urls[i], link))
      .catch((err) => {
        opts.replace(`![](${urls[i]})`, '')
        opts.onError(err)
      })
      .finally(() => {
        opts.onPending(-1)
        URL.revokeObjectURL(urls[i])
      })
  })
  return true
}

// 粘贴或拖入图片
export function pasteImages(opts: PasteImagesOptions): Extension {
  return [
    uploadOptions.of(opts),
    EditorView.domEventHandlers({
      paste(e, view) {
        // 个别浏览器/来源只在 items 中提供图片
        let files = [...(e.clipboardData?.files ?? [])]
        if (!files.length) {
          files = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter((f) => f !== null)
        }
        if (!insertImageFiles(view, files)) return false
        e.preventDefault()
        return true
      },
      drop(e, view) {
        const files = [...(e.dataTransfer?.files ?? [])]
        const pos = view.posAtCoords(e)
        if (!files.length || !insertImageFiles(view, files, pos ?? undefined)) return false
        e.preventDefault()
        return true
      },
    }),
  ]
}
