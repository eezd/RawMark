// 编辑器演示页（无需登录），用于性能与交互的自动化测试
import { createEditorState, createEditorView } from '../editor'
import sample from './sample.md?raw'
import '../themes/base.css'

// ?repeat=N 将示例重复 N 次，用于大文档性能测试
const repeat = Number(new URLSearchParams(location.search).get('repeat') ?? 1)
const doc = Array.from({ length: Math.max(1, repeat) }, () => sample).join('\n')

const view = createEditorView(document.getElementById('app')!, createEditorState({ doc }))
;(window as unknown as { rawmarkView: typeof view }).rawmarkView = view
