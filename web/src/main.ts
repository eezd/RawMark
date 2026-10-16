// M0 原型入口：只挂载编辑器，M1 替换为 Vue 外壳
import { createEditor } from './editor'
import sample from './demo/sample.md?raw'
import './themes/base.css'

// ?repeat=N 将示例重复 N 次，用于大文档性能测试
const repeat = Number(new URLSearchParams(location.search).get('repeat') ?? 1)
const doc = Array.from({ length: Math.max(1, repeat) }, () => sample).join('\n')

const view = createEditor({ parent: document.getElementById('app')!, doc })
;(window as unknown as { rawmarkView: typeof view }).rawmarkView = view
