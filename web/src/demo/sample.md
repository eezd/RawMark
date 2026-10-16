# RawMark 原型

这是 **M0 原型**，用来验证 *Live Preview* 的手感。光标所在的行显示 Markdown 源码，其余行显示渲染效果。

## 行内语法

支持 **粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://vuejs.org/guide/introduction.html) 和自动链接 <https://example.com>。
按住 Ctrl/Cmd 点击链接可以打开。转义字符 \*不会变成斜体\*。

## 列表

- 无序列表第一项
- 第二项，包含 `code`
  - 嵌套项
1. 有序列表
2. 第二项

- [ ] 待办事项（点击复选框切换）
- [x] 已完成事项

> 引用块：纯粹的 Markdown，不做格式转换。
> 第二行引用

---

## 代码块

```ts
import { ref, computed } from 'vue'

// 计数器
const count = ref(0)
const double = computed(() => count.value * 2)

export function increment(step: number = 1): void {
  count.value += step
}
```

```python
def fib(n: int) -> int:
    """返回第 n 个斐波那契数"""
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

```go
func main() {
	fmt.Println("hello, rawmark")
}
```

## 图片

![示例图片](https://vuejs.org/images/logo.png)

## 表格（M2 实现可视化编辑）

| 功能 | 状态 |
| --- | --- |
| Live Preview | 原型 |
| 表格 | M2 |
