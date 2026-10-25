package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"rawmark/internal/vault"
)

func TestTrashRetentionSettingsValidation(t *testing.T) {
	f := newFixture(t)
	for _, body := range []string{`{"trashRetentionDays":-1}`, `{"trashRetentionDays":0.5}`, `{"trashRetentionDays":"30"}`, `{"trashRetentionDays":true}`, `{"trashRetentionDays":9007199254740992}`} {
		if code := f.status(f.admin, "PATCH", "/api/v1/settings", body, nil); code != 400 {
			t.Fatalf("应拒绝 %s: %d", body, code)
		}
	}
	for _, value := range []string{"30", "0", "9007199254740991", "null"} {
		if code := f.status(f.admin, "PATCH", "/api/v1/settings", `{"trashRetentionDays":`+value+`}`, nil); code != 200 {
			t.Fatalf("应接受 %s: %d", value, code)
		}
	}
	for _, raw := range []string{`{}`, `{"trashRetentionDays":null}`} {
		settings := map[string]json.RawMessage{}
		if err := json.Unmarshal([]byte(raw), &settings); err != nil {
			t.Fatal(err)
		}
		if days, err := trashRetentionDays(settings); err != nil || days != 30 {
			t.Fatalf("缺省应30天: %d %v", days, err)
		}
	}
}

func TestTrashClearAuthorization(t *testing.T) {
	f := newFixture(t)
	f.write("a.md", "content")
	decode[vault.TrashItem](t, f.do(f.admin, "DELETE", "/api/v1/files/a.md", "", nil))
	for _, scope := range []string{"read", "write"} {
		token := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"test","scope":"`+scope+`"}`, nil)).Token
		headers := map[string]string{"Authorization": "Bearer " + token}
		if scope == "read" {
			if code := f.status(&http.Client{}, "DELETE", "/api/v1/trash", "", headers); code != 403 {
				t.Fatalf("只读不能清空: %d", code)
			}
		} else {
			result := decode[vault.TrashPurgeResult](t, f.do(&http.Client{}, "DELETE", "/api/v1/trash", "", headers))
			if len(result.Deleted) != 1 || len(result.Failed) != 0 {
				t.Fatalf("写令牌清空结果异常: %+v", result)
			}
		}
	}
}

func TestCleanupUsesSavedRetentionAndPreservesInvalidEntries(t *testing.T) {
	f := newFixture(t)
	v, err := vault.Open(f.root)
	if err != nil {
		t.Fatal(err)
	}
	f.write("old.md", "content")
	item, err := v.Delete("old.md")
	if err != nil {
		t.Fatal(err)
	}
	metaPath := filepath.Join(f.root, ".rawmark/trash", item.ID, "meta.json")
	item.DeletedAt = time.Now().Add(-40 * 24 * time.Hour).UnixMilli()
	meta, _ := json.Marshal(item)
	if err := os.WriteFile(metaPath, meta, 0600); err != nil {
		t.Fatal(err)
	}
	s := New(v, nil, f.store, f.hub, nil)
	for _, value := range []string{`{"trashRetentionDays":0}`, `{"trashRetentionDays":-1}`, `{"trashRetentionDays":"broken"}`} {
		if err := f.store.SetSetting(settingsKey, value); err != nil {
			t.Fatal(err)
		}
		err := s.cleanupTrash(time.Now())
		if value != `{"trashRetentionDays":0}` && err == nil {
			t.Fatal("无效配置不可静默降级为默认删除")
		}
		if _, err := os.Stat(metaPath); err != nil {
			t.Fatalf("禁用或无效设置不应删除: %v", err)
		}
	}
	if err := f.store.SetSetting(settingsKey, `{}`); err != nil {
		t.Fatal(err)
	}
	if err := s.cleanupTrash(time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(metaPath); !os.IsNotExist(err) {
		t.Fatalf("缺省30天应删除旧条目: %v", err)
	}
}
