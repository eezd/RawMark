package vault

import (
	"bytes"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark/v2/ast"
	"github.com/yuin/goldmark/v2/extension"
	"github.com/yuin/goldmark/v2/parser"
	"github.com/yuin/goldmark/v2/text"
	"github.com/yuin/goldmark/v2/util"
)

// Relationship extraction only: math and code are not body text, so #1 and example links must not become knowledge relationships.
// Delimiter rules match frontend Typora extensions; this parser does not render Markdown.
type metadataMath struct{}

func (metadataMath) Trigger() []byte { return []byte{'$'} }
func (metadataMath) Open(parent ast.Node, reader text.Reader, _ parser.Context) (ast.Node, parser.State) {
	line, _ := reader.PeekLine()
	if parent.Kind() != ast.KindDocument || !bytes.Equal(bytes.TrimSpace(line), []byte("$$")) {
		return nil, parser.NoChildren
	}
	return ast.NewCodeBlock(ast.CodeBlockKindFenced, text.Lines{}), parser.NoChildren
}
func (metadataMath) Continue(node ast.Node, reader text.Reader, _ parser.Context) parser.State {
	line, segment := reader.PeekLine()
	reader.AdvanceToEOL()
	if bytes.Equal(bytes.TrimSpace(line), []byte("$$")) {
		return parser.Close
	}
	node.(*ast.CodeBlock).Value.AppendSegment(segment)
	return parser.Continue | parser.NoChildren
}
func (metadataMath) Close(ast.Node, text.Reader, parser.Context) {}
func (metadataMath) CanInterruptParagraph() bool                 { return true }
func (metadataMath) CanAcceptIndentedLine() bool                 { return false }
func (metadataMath) Parse(_ ast.Node, reader text.Reader, _ parser.Context) ast.Node {
	line, first := reader.PeekLine()
	if len(line) < 2 || line[1] == '$' {
		return nil
	}
	next, _ := utf8.DecodeRune(line[1:])
	if unicode.IsSpace(next) {
		return nil
	}
	savedLine, savedPosition := reader.Position()
	reader.Advance(1)
	for {
		line, segment := reader.PeekLine()
		if line == nil {
			reader.SetPosition(savedLine, savedPosition)
			return nil
		}
		for i := 0; i < len(line); i++ {
			if line[i] == '\\' {
				i++
				continue
			}
			if line[i] != '$' || i == 0 {
				continue
			}
			prev, _ := utf8.DecodeLastRune(line[:i])
			if unicode.IsSpace(prev) {
				continue
			}
			if i+1 < len(line) && line[i+1] >= '0' && line[i+1] <= '9' {
				continue
			}
			reader.Advance(i + 1)
			return ast.NewCodeSpan(text.NewSingleLineValueFromIndex(text.NewIndex(first.Start, segment.Start+i+1), nil))
		}
		reader.AdvanceLine()
	}
}
func parseMetadata(source []byte) ast.Node {
	math := metadataMath{}
	return parser.New(parser.WithExtensions(extension.GFMParser, extension.FootnoteParser), parser.WithBlockParsers(util.Prioritized[parser.BlockParser](math, 650)), parser.WithInlineParsers(util.Prioritized[parser.InlineParser](math, 150))).Parse(source)
}

// Return non-body byte ranges so lossless link rewriting can skip example syntax inside math.
func nonProseRanges(root ast.Node) [][2]int {
	var ranges [][2]int
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch node := node.(type) {
		case *ast.CodeSpan:
			for _, index := range node.Value.Indices() {
				ranges = append(ranges, [2]int{index.Start, index.Stop})
			}
			return ast.WalkSkipChildren, nil
		case *ast.CodeBlock:
			for _, index := range node.Value.Segments() {
				ranges = append(ranges, [2]int{index.Start, index.Stop})
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	return ranges
}
