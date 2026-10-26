import type { EditorState, Extension, TransactionSpec } from '@codemirror/state'
import { t as translate } from '@@/i18n/runtime'
import { isolateHistory } from '@codemirror/commands'
import { Facet, StateEffect, StateField } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export interface PasteImagesOptions {
  // Do not start asynchronous paste or uploads during file moves; returned resource links could target the old path.
  canPaste: () => boolean
  // Upload a file and return its Markdown link.
  upload: (file: File) => Promise<string>
  importImage: (url: string) => Promise<string>
  // Update by note identity; the note may be in the background when asynchronous paste or upload completes.
  update: (change: (state: EditorState) => TransactionSpec | undefined) => void
  onError: (err: unknown) => void
  // Notify upload start/end so the save queue can pause and avoid writing temporary blob: URLs to files.
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
      // Edits or undo while waiting must not be overwritten by a late conversion result.
      // Locate successive pastes at the same position in initiation order, independent of image-download completion order.
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
    opts.onError(new Error(translate('workspace.could_not_convert_the_web_4f0e6a'), { cause: error }))
    return text
  }).then(insert).catch(opts.onError).finally(() => opts.onPending(-1))
}

/**
 * Insert image files from paste, drop, or photo selection: immediately show blob: placeholders, then replace them with
 * uploaded links. Return whether insertion was handled, including operation-conflict rejection; do nothing if upload is unconfigured.
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

// Paste or drop images.
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
        // Some browsers/sources expose images only through items.
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
