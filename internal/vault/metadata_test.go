package vault

import (
	"reflect"
	"strings"
	"testing"
)

func TestAnalyzeRelationshipsAndTags(t *testing.T) {
	content := "---\ntags: [知识, daily]\n---\n# 标题\n正文 #读书 和 #tag/nested\n[笔记](../目标.md#章节) ![图片](a.assets/p.png) [引用][ref]\n\n[ref]: other.md\n\n`#code [伪](bad.md)`\n```\n#not-tag\n[fake](fake.md)\n```\n"
	m := Analyze("dir/a.md", []byte(content))
	if !reflect.DeepEqual(m.Tags, []string{"daily", "tag/nested", "知识", "读书"}) {
		t.Fatalf("标签不符：%v", m.Tags)
	}
	if len(m.Links) != 2 || m.Links[0].Target != "目标.md" || m.Links[1].Target != "dir/other.md" || m.Links[0].Line != 6 {
		t.Fatalf("链接不符：%+v", m.Links)
	}
	if len(m.Assets) != 1 || m.Assets[0].Target != "dir/a.assets/p.png" {
		t.Fatalf("图片引用不符：%+v", m.Assets)
	}
	if len(m.Warnings) != 0 {
		t.Fatal(m.Warnings)
	}
	for _, content := range []string{"---\ntags: [broken\n---\n", "---\ntags: {key: value}\n---", "---\ntags: 12\n---", "---\ntags: x"} {
		if len(Analyze("x.md", []byte(content)).Warnings) == 0 {
			t.Fatalf("无效元数据未报告：%s", content)
		}
	}
}

func TestMoveMaintainsIncomingAndOutgoingLinks(t *testing.T) {
	v := newVault(t)
	for p, body := range map[string]string{
		"dir/a.md": "[外部](../other.md) [同级](b.md#section) ![](a.assets/p.png)\n`[不改](b.md)`\n",
		"dir/b.md": "[入链](a.md?q=1#section)", "other.md": "[入链](dir/a.md)",
	} {
		if _, err := v.Write(p, []byte(body), Precondition{}); err != nil {
			t.Fatal(err)
		}
	}
	legacyAsset(t, v, "dir/a.md", "p.png", "image")
	if _, err := v.Move("dir/a.md", "new/renamed.md"); err != nil {
		t.Fatal(err)
	}
	body, _, _ := v.Read("new/renamed.md")
	if !strings.Contains(string(body), "../dir/b.md#section") || !strings.Contains(string(body), "renamed.assets/p.png") || !strings.Contains(string(body), "`[不改](b.md)`") {
		t.Fatalf("出链错误：%s", body)
	}
	body, _, _ = v.Read("dir/b.md")
	if string(body) != "[入链](../new/renamed.md?q=1#section)" {
		t.Fatalf("入链错误：%s", body)
	}
	if _, err := v.Move("new", "deep/folder"); err != nil {
		t.Fatal(err)
	}
	body, _, _ = v.Read("deep/folder/renamed.md")
	if !strings.Contains(string(body), "../../other.md") {
		t.Fatalf("目录出链错误：%s", body)
	}
}

func TestMetadataSkipsMathAndResolvesFootnotes(t *testing.T) {
	content := "#正文\n\n公式 $x + #1 + [fake](bad.md)$\n\n$$\n#2 [fake](bad2.md) <img src=\"assets/fake.png\">\n$$\n\n脚注[^a]\n\n[^a]: ![图片](assets/foot.png)\n\n\\#escaped https://example.com/?x=#url\n"
	m := Analyze("a.md", []byte(content))
	if !reflect.DeepEqual(m.Tags, []string{"正文"}) || len(m.Links) != 0 || len(m.Assets) != 1 || m.Assets[0].Target != "assets/foot.png" {
		t.Fatalf("扩展语法误识别：%+v", m)
	}
	rewritten, err := rewriteLocalLinks([]byte(content), "a.md", "dir/a.md", func(target string) string { return target })
	if err != nil || !strings.Contains(string(rewritten), "[fake](bad.md)") || !strings.Contains(string(rewritten), "[fake](bad2.md)") || !strings.Contains(string(rewritten), "../assets/foot.png") {
		t.Fatalf("公式或脚注改写不符：%s %v", rewritten, err)
	}
}

func TestRenamedAssetsPreserveMathExamples(t *testing.T) {
	content := "公式 $x + ![](a.assets/fake.png)$\n\n$$\n<img src=\"a.assets/fake.png\">\n$$\n\n![](a.assets/real.png)\n"
	got := string(RewriteAssetLinks([]byte(content), "a", "b"))
	if !strings.Contains(got, "$x + ![](a.assets/fake.png)$") || !strings.Contains(got, "src=\"a.assets/fake.png\"") || !strings.Contains(got, "![](b.assets/real.png)") {
		t.Fatalf("公式示例被修改：%s", got)
	}
}

func TestMovePreservesEntityShapedFilenames(t *testing.T) {
	v := newVault(t)
	for p, body := range map[string]string{"source.md": "[目标](target.md)", "target.md": "正文"} {
		if _, err := v.Write(p, []byte(body), Precondition{}); err != nil {
			t.Fatal(err)
		}
	}
	const target = "a&copy;.md"
	if _, err := v.Move("target.md", target); err != nil {
		t.Fatal(err)
	}
	body, _, err := v.Read("source.md")
	if err != nil {
		t.Fatal(err)
	}
	metadata := Analyze("source.md", body)
	if string(body) != "[目标](a%26copy;.md)" || len(metadata.Links) != 1 || metadata.Links[0].Target != target {
		t.Fatalf("改名后的链接指向错误：%s %+v", body, metadata.Links)
	}
	if _, _, err := v.Read(metadata.Links[0].Target); err != nil {
		t.Fatal("改写后的链接无法打开", err)
	}
}
