import type { EditorState, Extension, TransactionSpec } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { Facet, StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface PasteImagesOptions {
  // 文件移动期间不能开始异步粘贴或上传，避免响应中的资源链接属于旧路径。
  canPaste: () => boolean
  // 上传文件，返回写入 Markdown 的链接
  upload: (file: File) => Promise<string>
  importImage: (url: string) => Promise<string>
  // 按笔记身份更新，异步粘贴或上传结束时该笔记可能已切到后台。
  update: (change: (state: EditorState) => TransactionSpec | undefined) => void
  onError: (err: unknown) => void
  // 上传开始/结束，供保存队列在上传期间暂缓保存（避免把临时的 blob: 地址写入文件）
  onPending: (delta: 1 | -1) => void
}

const uploadOptions = Facet.define<PasteImagesOptions, PasteImagesOptions | undefined>({ combine: v => v[0] })

const pasteRange = StateEffect.define<{ id: object, from: number, to: number } | { id: object }>()
const pendingPastes = StateField.define<Map<object, { from: number, to: number }>>({
  create: () => new Map(),
  update(value, transaction) {
    const next = new Map<object, { from: number, to: number }>()
    let completed: object | undefined
    for (const effect of transaction.effects) {
      if (effect.is(pasteRange) && !('from' in effect.value)) completed = effect.value.id
    }
    let afterCompleted = false
    for (const [id, range] of value) {
      if (id === completed) {
        afterCompleted = true; continue
      }
      let edited = transaction.isUserEvent('undo')
      transaction.changes.iterChangedRanges((from, to) => {
        if ((from < range.to && to > range.from) || (from === to && from > range.from && from < range.to)) edited = true
      })
      // 用户在等待期间编辑或撤销了粘贴内容，迟到的转换结果不能覆盖输入。
      // 同一位置连续粘贴时按发起顺序定位，与图片下载完成的先后无关。
      const association = range.from === range.to ? (afterCompleted ? 1 : -1) : 1
      if (!edited) next.set(id, { from: transaction.changes.mapPos(range.from, association), to: transaction.changes.mapPos(range.to, range.from === range.to ? association : -1) })
    }
    for (const effect of transaction.effects) {
      if (effect.is(pasteRange)) {
        if ('from' in effect.value) next.set(effect.value.id, { from: effect.value.from, to: effect.value.to })
        else next.delete(effect.value.id)
      }
    }
    return next
  },
})

function replaceText(opts: PasteImagesOptions, text: string, replacement: string) {
  opts.update((state) => {
    const at = state.doc.toString().indexOf(text)
    if (at >= 0) return { changes: { from: at, to: at + text.length, insert: replacement } }
  })
}

function insertHTML(view: EditorView, html: string, text: string, opts: PasteImagesOptions) {
  const id = {}
  const range = view.state.selection.main
  opts.onPending(1)
  view.dispatch({ effects: pasteRange.of({ id, from: range.from, to: range.to }) })
  const insert = (markdown: string) => {
    opts.update((state) => {
      const pending = state.field(pendingPastes).get(id)
      if (pending) {
        return {
          changes: { from: pending.from, to: pending.to, insert: markdown },
          selection: state.selection.main.from === pending.from && state.selection.main.to === pending.to ? { anchor: pending.from + markdown.length } : undefined,
          effects: pasteRange.of({ id }),
          userEvent: 'input.paste',
          annotations: isolateHistory.of('full'),
        }
      }
    })
  }
  void import('./html-paste').then(({ htmlToMarkdown }) => htmlToMarkdown(html, opts.importImage, opts.onError)).catch((error) => {
    opts.onError(new Error('网页转换失败，已保留剪贴板纯文本', { cause: error }))
    return text
  }).then(insert).catch(opts.onError).finally(() => opts.onPending(-1))
}

/**
 * 插入图片文件（粘贴、拖入、从相册选择共用）：先用 blob: 地址插入占位，立即显示；上传完成后替换为正式链接。
 * 返回是否已处理图片插入（包括因操作冲突被拒绝）；未配置上传时不处理
 */
export function insertImageFiles(view: EditorView, files: File[], pos?: number): boolean {
  const opts = view.state.facet(uploadOptions)
  const images = files.filter(f => f.type.startsWith('image/'))
  if (!opts || !images.length) return false
  if (!opts.canPaste()) return true
  const urls = images.map(f => URL.createObjectURL(f))
  const text = urls.map(u => `![](${u})`).join('\n')
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
      .then(link => replaceText(opts, urls[i], link))
      .catch((err) => {
        replaceText(opts, `![](${urls[i]})`, '')
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
  let plain = false
  return [
    uploadOptions.of(opts),
    pendingPastes,
    EditorView.domEventHandlers({
      keydown(e) {
        plain = e.shiftKey
      },
      keyup(e) {
        plain = e.shiftKey
      },
      blur() {
        plain = false
      },
      paste(e, view) {
        if (view.state.readOnly || plain) return false
        const html = e.clipboardData?.getData('text/html')
        if (html) {
          if (opts.canPaste()) insertHTML(view, html, e.clipboardData!.getData('text/plain'), opts)
          e.preventDefault()
          return true
        }
        // 个别浏览器/来源只在 items 中提供图片
        let files = [...(e.clipboardData?.files ?? [])]
        if (!files.length) {
          files = [...(e.clipboardData?.items ?? [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(f => f !== null)
        }
        if (!insertImageFiles(view, files)) return false
        e.preventDefault()
        return true
      },
      drop(e, view) {
        if (view.state.readOnly) return false
        const files = [...(e.dataTransfer?.files ?? [])]
        const pos = view.posAtCoords(e)
        if (!files.length || !insertImageFiles(view, files, pos ?? undefined)) return false
        e.preventDefault()
        return true
      },
    }),
  ]
}
