package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type TrashFailure struct {
	ID    string `json:"id"`
	Error string `json:"error"`
}

type TrashPurgeResult struct {
	Deleted []string       `json:"deleted"`
	Failed  []TrashFailure `json:"failed"`
}

// PurgeTrash 在与恢复相同的写锁内读取元数据并清理。days=0 清空所有；
// 自动清理的“永不删除”由调用方处理，不调用本方法。
func (v *Vault) PurgeTrash(days int64, now time.Time) (TrashPurgeResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	result := TrashPurgeResult{Deleted: []string{}, Failed: []TrashFailure{}}
	if days < 0 {
		return result, fmt.Errorf("保留天数不能为负数")
	}
	dirs, err := os.ReadDir(v.trash)
	if err != nil {
		return result, err
	}
	for _, dir := range dirs {
		id := dir.Name()
		if !trashIDPattern.MatchString(id) {
			continue // 不删除非本程序管理的文件。
		}
		item, err := v.readTrashItem(id)
		if err == nil && days > 0 && (item.DeletedAt > now.UnixMilli() || (now.UnixMilli()-item.DeletedAt)/int64(24*time.Hour/time.Millisecond) < days) {
			continue
		}
		if err == nil {
			err = os.RemoveAll(filepath.Join(v.trash, id))
		}
		if err != nil {
			result.Failed = append(result.Failed, TrashFailure{ID: id, Error: err.Error()})
		} else {
			result.Deleted = append(result.Deleted, id)
		}
	}
	return result, nil
}
