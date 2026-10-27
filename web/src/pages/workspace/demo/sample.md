# RawMark Demo

Write in **Markdown** with _Live Preview_. The line under your cursor shows its source; other lines display the formatted result.

## Inline formatting

Try **bold**, _italic_, ~~strikethrough~~, `inline code`, [links](https://vuejs.org/guide/introduction.html), and automatic links <https://example.com>.
Hold Ctrl/Cmd and click a link to open it. Escaped characters \*stay as plain text\*.

## Lists

- Capture an idea
- Add a detail with `code`
  - Keep related thoughts together

1. Make a plan
2. Take the next step

- [ ] Write a new note (click the checkbox to toggle)
- [x] Organize your workspace

> Your notes are ordinary Markdown files.
> Keep writing with the tools you already know.

---

## Code blocks

```ts
import { computed, ref } from 'vue'

// A simple counter
const count = ref(0)
const double = computed(() => count.value * 2)

export function increment(step: number = 1): void {
  count.value += step
}
```

```python
def fib(n: int) -> int:
    """Return the nth Fibonacci number."""
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

```go
func main() {
	fmt.Println("hello, rawmark")
}
```

## Images

![RawMark icon](./icon.svg)

## Tables

Click a cell to edit, press Tab to move between cells, and hover over the table to show its toolbar.

| Feature      | Try it               |
| ------------ | -------------------- |
| Live Preview | Move your cursor     |
| Tables       | Edit a cell directly |
