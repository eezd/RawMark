package vault

import "rawmark/internal/i18n"

type CleanupResult struct {
	Deleted []TrashItem   `json:"deleted"`
	Skipped []CleanupSkip `json:"skipped"`
}
type CleanupSkip struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
	Cause  error  `json:"-"`
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
			return result, i18n.New("w_invalid_metadata_in_s_478c93", ErrInvalidPath, entry.Path, metadata.Diagnostics[0])
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
		var reason error
		switch {
		case !IsImage(p):
			reason = i18n.New("image_not_file")
		case references[p]:
			reason = i18n.New("image_in_use")
		default:
			info, err := v.Stat(p)
			if err != nil {
				reason = err
			} else if !info.Mode().IsRegular() {
				reason = i18n.New("image_not_file")
			}
		}
		if reason != nil {
			result.Skipped = append(result.Skipped, CleanupSkip{p, reason.Error(), reason})
			continue
		}
		item, err := v.deleteLocked(p)
		if err != nil {
			result.Skipped = append(result.Skipped, CleanupSkip{p, err.Error(), err})
			continue
		}
		result.Deleted = append(result.Deleted, item)
	}
	return result, nil
}
