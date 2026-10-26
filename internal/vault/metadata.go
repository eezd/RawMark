package vault

import (
	"bytes"
	"html"
	"net/url"
	"path"
	"rawmark/internal/i18n"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark/v2/ast"
	"go.yaml.in/yaml/v3"
)

type Reference struct {
	Target string `json:"target"`
	Line   int    `json:"line"`
}

type Metadata struct {
	Title       string        `json:"title"`
	Tags        []string      `json:"tags"`
	Links       []Reference   `json:"links"`
	Assets      []Reference   `json:"assets"`
	Warnings    []string      `json:"warnings"`
	Diagnostics []*i18n.Error `json:"-"`
}

var inlineTag = regexp.MustCompile(`#[\p{L}\p{N}_][\p{L}\p{N}_/-]*`)

// LocalTarget decodes Markdown and URLs at the link boundary, rejecting remote URLs, absolute paths, and out-of-bounds paths.
func LocalTarget(note, raw string) (string, *url.URL, bool) {
	raw = html.UnescapeString(markdownEscape.ReplaceAllString(raw, "$1"))
	u, err := url.Parse(raw)
	if err != nil || u.IsAbs() || u.Host != "" || strings.HasPrefix(raw, "/") || u.Path == "" {
		return "", nil, false
	}
	target := path.Clean(path.Join(path.Dir(note), u.Path))
	if _, err := CleanPath(target); err != nil {
		return "", nil, false
	}
	return target, u, true
}

// Analyze extracts semantic relationships without reserializing text; source positions remain original line numbers.
func Analyze(note string, content []byte) Metadata {
	m := Metadata{Title: strings.TrimSuffix(path.Base(note), NoteExt), Tags: []string{}, Links: []Reference{}, Assets: []Reference{}, Warnings: []string{}}
	addWarning := func(key string, args ...any) {
		diagnostic := i18n.New(key, args...)
		m.Diagnostics = append(m.Diagnostics, diagnostic)
		m.Warnings = append(m.Warnings, diagnostic.Error())
	}
	tags := map[string]bool{}
	addTag := func(s string) {
		s = strings.TrimPrefix(strings.TrimSpace(s), "#")
		if s != "" {
			tags[s] = true
		}
	}
	source := bytes.Clone(content)
	lines := bytes.SplitAfter(source, []byte("\n"))
	if len(lines) > 0 && strings.TrimSpace(string(lines[0])) == "---" {
		end, bodyEnd, offset := -1, 0, len(lines[0])
		for i := 1; i < len(lines); i++ {
			if strings.TrimSpace(string(lines[i])) == "---" {
				bodyEnd = offset
				end = offset + len(lines[i])
				break
			}
			offset += len(lines[i])
		}
		if end < 0 {
			addWarning("metadata_unclosed")
			end = len(source)
		} else {
			var front struct {
				Tags  yaml.Node `yaml:"tags"`
				Title string    `yaml:"title"`
			}
			if err := yaml.Unmarshal(source[len(lines[0]):bodyEnd], &front); err != nil {
				addWarning("metadata_invalid", err)
			} else {
				if front.Title != "" {
					m.Title = front.Title
				}
				switch front.Tags.Kind {
				case 0:
				case yaml.ScalarNode:
					if front.Tags.Tag == "!!str" {
						for _, tag := range strings.FieldsFunc(front.Tags.Value, func(r rune) bool { return r == ',' || unicode.IsSpace(r) }) {
							addTag(tag)
						}
					} else {
						addWarning("metadata_tags")
					}
				case yaml.SequenceNode:
					for _, tag := range front.Tags.Content {
						if tag.Kind != yaml.ScalarNode || tag.Tag != "!!str" {
							addWarning("metadata_tag_list")
							break
						}
						addTag(tag.Value)
					}
				default:
					addWarning("metadata_tags")
				}
			}
		}
		for i := 0; i < end; i++ {
			if source[i] != '\n' && source[i] != '\r' {
				source[i] = ' '
			}
		}
	}
	root := parseMetadata(source)
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		addRef := func(raw string, pos int) {
			target, _, ok := LocalTarget(note, raw)
			if !ok {
				return
			}
			ref := Reference{target, bytes.Count(source[:max(0, pos)], []byte("\n")) + 1}
			if IsNote(target) {
				m.Links = append(m.Links, ref)
			} else {
				m.Assets = append(m.Assets, ref)
			}
		}
		switch node := n.(type) {
		case *ast.AutoLink, *ast.CodeBlock, *ast.CodeSpan, *ast.HTMLBlock, *ast.RawHTML, *ast.LinkReferenceDefinition:
			return ast.WalkSkipChildren, nil
		case *ast.Link:
			addRef(node.Destination.Str(source), node.Pos())
			// Link labels may contain nested images whose resource references must still be recorded.
		case *ast.Image:
			addRef(node.Destination.Str(source), node.Pos())
			return ast.WalkSkipChildren, nil
		case *ast.Text:
			value := node.Value.Str(source)
			for _, loc := range inlineTag.FindAllStringIndex(value, -1) {
				if loc[0] > 0 {
					prev, _ := utf8.DecodeLastRuneInString(value[:loc[0]])
					if unicode.IsLetter(prev) || unicode.IsNumber(prev) || prev == '/' || prev == '\\' || prev == '&' {
						continue
					}
				}
				addTag(value[loc[0]:loc[1]])
			}
		}
		return ast.WalkContinue, nil
	})
	// Historically imported notes may reference HTML resources; cleanup must include them.
	excluded := nonProseRanges(root)
	for _, span := range importLinkSpans(content) {
		if !span.html {
			continue
		}
		skip := false
		for _, region := range excluded {
			if span.start >= region[0] && span.start < region[1] {
				skip = true
				break
			}
		}
		if skip {
			continue
		}
		target, _, ok := LocalTarget(note, string(content[span.start:span.end]))
		if ok {
			m.Assets = append(m.Assets, Reference{target, bytes.Count(content[:span.start], []byte("\n")) + 1})
		}
	}
	for tag := range tags {
		m.Tags = append(m.Tags, tag)
	}
	sort.Strings(m.Tags)
	return m
}
