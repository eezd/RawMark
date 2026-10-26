package vault

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"rawmark/internal/i18n"
	"time"
)

// The caller holds the write lock and has validated metadata. Delete contents first, retaining management metadata on failure.
func (v *Vault) purgeTrashItemLocked(metadata trashMetadata) error {
	dir := filepath.Join(v.trash, metadata.ID)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() == "meta.json" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return err
		}
	}
	metaPath := filepath.Join(dir, "meta.json")
	if err := os.Remove(metaPath); err != nil {
		return err
	}
	if err := os.Remove(dir); err != nil {
		// A non-writable parent or similar error can still block the final rmdir; restore metadata to allow later cleanup.
		data, _ := json.Marshal(metadata)
		return errors.Join(err, atomicWrite(metaPath, data))
	}
	return nil
}

type TrashFailure struct {
	ID    string `json:"id"`
	Error string `json:"error"`
	Cause error  `json:"-"`
}

type TrashPurgeResult struct {
	Deleted []string       `json:"deleted"`
	Failed  []TrashFailure `json:"failed"`
}

// PurgeTrash reads metadata and cleans entries under the same write lock as restore. days=0 empties everything;
// the caller handles automatic cleanup's "never delete" setting by not invoking this method.
func (v *Vault) PurgeTrash(days int64, now time.Time) (TrashPurgeResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	result := TrashPurgeResult{Deleted: []string{}, Failed: []TrashFailure{}}
	if days < 0 {
		return result, i18n.New("retention_days_cannot_be_negative_f37c9b")
	}
	dirs, err := os.ReadDir(v.trash)
	if err != nil {
		return result, err
	}
	for _, dir := range dirs {
		id := dir.Name()
		if !trashIDPattern.MatchString(id) {
			continue // Do not delete files not managed by this application.
		}
		metadata, err := v.readTrashMetadata(id)
		if err == nil && days > 0 && (metadata.DeletedAt > now.UnixMilli() || (now.UnixMilli()-metadata.DeletedAt)/int64(24*time.Hour/time.Millisecond) < days) {
			continue
		}
		if err == nil {
			err = v.purgeTrashItemLocked(metadata)
		}
		if err != nil {
			result.Failed = append(result.Failed, TrashFailure{ID: id, Error: err.Error(), Cause: err})
		} else {
			result.Deleted = append(result.Deleted, id)
		}
	}
	return result, nil
}
