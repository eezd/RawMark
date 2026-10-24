package vault

import "fmt"

type CleanupResult struct {
	Deleted []TrashItem   `json:"deleted"`
	Skipped []CleanupSkip `json:"skipped"`
}
type CleanupSkip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// CleanupImages 在写锁内重新扫描引用；派生索引不作为删除依据。
func (v *Vault) CleanupImages(paths []string) (CleanupResult, error) {
	result := CleanupResult{Deleted: []TrashItem{}, Skipped: []CleanupSkip{}}
	v.mu.Lock()
	defer v.mu.Unlock()
	entries, err := v.Tree()
	if err != nil {
		return result, err
	}
	references := map[string]bool{}
	for _, entry := range entries {
		if entry.Dir || !IsNote(entry.Path) {
			continue
		}
		content, _, err := v.Read(entry.Path)
		if err != nil {
			return result, err
		}
		metadata := Analyze(entry.Path, content)
		if len(metadata.Warnings) > 0 {
			return result, fmt.Errorf("%w：%s 的元数据异常，无法确认全库引用：%s", ErrInvalidPath, entry.Path, metadata.Warnings[0])
		}
		for _, ref := range metadata.Assets {
			references[ref.Target] = true
		}
	}
	seen := map[string]bool{}
	for _, p := range paths {
		if seen[p] {
			continue
		}
		seen[p] = true
		reason := ""
		switch {
		case !IsImage(p):
			reason = "不是图片文件"
		case references[p]:
			reason = "仍被笔记引用"
		default:
			info, err := v.Stat(p)
			if err != nil {
				reason = err.Error()
			} else if !info.Mode().IsRegular() {
				reason = "不是图片文件"
			}
		}
		if reason != "" {
			result.Skipped = append(result.Skipped, CleanupSkip{p, reason})
			continue
		}
		item, err := v.deleteLocked(p)
		if err != nil {
			result.Skipped = append(result.Skipped, CleanupSkip{p, err.Error()})
			continue
		}
		result.Deleted = append(result.Deleted, item)
	}
	return result, nil
}
