package vault

import (
	"strings"
	"testing"
)

func TestRewriteAssetLinksPreservesCodeBlocks(t *testing.T) {
	for _, tc := range []struct {
		name string
		code string
	}{
		{"缩进", "    ![](a.assets/code.png)\n"},
		{"制表符", "\t![](a.assets/code.png)\n"},
		{"引用围栏", "> ```markdown\n> ![](a.assets/code.png)\n> ```\n"},
		{"引用缩进", ">     ![](a.assets/code.png)\n"},
		{"列表围栏", "- ```markdown\n  ![](a.assets/code.png)\n  ```\n"},
		{"有序列表第二项围栏", "1. 项目\n2. ```markdown\n   ![](a.assets/code.png)\n   ```\n"},
		{"右括号列表第二项围栏", "1) 项目\n2) ```markdown\n   ![](a.assets/code.png)\n   ```\n"},
		{"引用内有序列表第二项围栏", "> 1. 项目\n> 2. ```markdown\n>    ![](a.assets/code.png)\n>    ```\n"},
		{"嵌套有序列表第二项围栏", "- 1. 项目\n  2. ```markdown\n     ![](a.assets/code.png)\n     ```\n"},
		{"列表缩进", "- 项目\n\n      ![](a.assets/code.png)\n"},
		{"有序列表缩进", "10. 项目\n\n        ![](a.assets/code.png)\n"},
		{"引用内嵌列表", "> - ```markdown\n>   ![](a.assets/code.png)\n>   ```\n"},
		{"围栏内四格关闭标记", "```markdown\n    ```\n![](a.assets/code.png)\n```\n"},
		{"标题后缩进代码", "# 标题\n    ![](a.assets/code.png)\n"},
		{"分隔线后缩进代码", "* * *\n    ![](a.assets/code.png)\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := tc.code + "\n![](a.assets/real.png)\n"
			want := tc.code + "\n![](b.assets/real.png)\n"
			if got := string(RewriteAssetLinks([]byte(input), "a", "b")); got != want {
				t.Fatalf("代码示例应保持原样，真实链接应更新:\n got %q\nwant %q", got, want)
			}
		})
	}
}

func TestRewriteAssetLinksInContainersAndParagraphs(t *testing.T) {
	for _, input := range []string{
		"> ![](a.assets/real.png)\n",
		"- ![](a.assets/real.png)\n",
		"- 项目\n\n    ![](a.assets/real.png)\n",
		"- 项目\n  - 子项\n    ![](a.assets/real.png)\n",
		"段落\n    ![](a.assets/real.png)\n",
		"段落\n2. 项目\n    ![](a.assets/real.png)\n",
		"> 段落\n    ![](a.assets/real.png)\n",
		"- 段落\n![](a.assets/real.png)\n    ![](a.assets/real.png)\n",
		"10. 项目\n\n    ![](a.assets/real.png)\n",
		"- 项目\n  - 子项\n    ```markdown\n    ![](a.assets/code.png)\n    ```\n\n  ![](a.assets/real.png)\n",
		"> ```markdown\n> ![](a.assets/code.png)\n\n![](a.assets/real.png)\n",
	} {
		want := strings.ReplaceAll(input, "a.assets/real.png", "b.assets/real.png")
		if got := string(RewriteAssetLinks([]byte(input), "a", "b")); got != want {
			t.Errorf("容器缩进与段落续行不应被当作代码:\n got %q\nwant %q", got, want)
		}
	}
}
