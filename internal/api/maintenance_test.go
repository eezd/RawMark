package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"rawmark/internal/backup"
	"rawmark/internal/store"
)

func TestGuardAPIOnlyEventsBypassActivityLock(t *testing.T) {
	for _, tc := range []struct {
		path   string
		locked bool
	}{
		{"/api/v1/events", false},
		{"/api/v1/resources/ticket/events/", false},
		{"/api/v1/resources/ticket/plugins/demo/assets/revision/events/lib.js", true},
		{"/api/v1/resources/ticket/images/events/picture.png", true},
		{"/api/v1/files/note.md", true},
	} {
		t.Run(tc.path, func(t *testing.T) {
			s := &Server{}
			called := false
			handler := s.guardAPI(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				lockFree := s.activity.TryLock()
				if lockFree {
					s.activity.Unlock()
				}
				if lockFree == tc.locked {
					t.Errorf("activity lock: free=%v, want locked=%v", lockFree, tc.locked)
				}
			}))
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", tc.path, nil))
			if !called {
				t.Fatal("request was not served")
			}
		})
	}
}

func exportedPackage(t *testing.T, f *fixture, kind string) []byte {
	t.Helper()
	res := f.do(f.admin, "POST", "/api/v1/maintenance/export/"+kind, "", nil)
	data, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != 200 {
		t.Fatalf("导出失败: %d %s", res.StatusCode, data)
	}
	return data
}
func uploadedPackage(t *testing.T, f *fixture, kind string, data []byte) string {
	t.Helper()
	res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads", `{"kind":"`+kind+`","size":`+strconv.Itoa(len(data))+`}`, nil)
	if res.StatusCode != 201 {
		t.Fatalf("创建上传失败: %d", res.StatusCode)
	}
	id := decode[struct{ ID string }](t, res).ID
	// 跨多个分块验证偏移，不引入测试开关。
	offset := 0
	for offset < len(data) {
		end := min(offset+137, len(data))
		res = f.do(f.admin, "PUT", "/api/v1/maintenance/uploads/"+id, string(data[offset:end]), map[string]string{"Upload-Offset": strconv.Itoa(offset)})
		if res.StatusCode != 200 {
			t.Fatalf("追加上传失败: %d", res.StatusCode)
		}
		next := decode[struct{ Offset int }](t, res).Offset
		if next != end {
			t.Fatalf("偏移不符: %d", next)
		}
		offset = next
	}
	return id
}
func stagedPackage(t *testing.T, f *fixture, kind string, data []byte) string {
	t.Helper()
	id := uploadedPackage(t, f, kind, data)
	res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads/"+id+"/validate", "", nil)
	if res.StatusCode != 200 {
		body, _ := io.ReadAll(res.Body)
		t.Fatalf("校验失败: %d %s", res.StatusCode, body)
	}
	return id
}
func assertOK(t *testing.T, res *http.Response) {
	t.Helper()
	if res.StatusCode != 200 {
		data, _ := io.ReadAll(res.Body)
		t.Fatalf("操作失败: %d %s", res.StatusCode, data)
	}
}
func TestSettingsPackageRoundTripMergesResourcesAndPreservesAccount(t *testing.T) {
	f := newFixture(t)
	f.write("note.md", "source")
	font := decode[fontInfo](t, uploadTestFont(t, f, f.admin, "original.woff2", testFontData(t)))
	assertOK(t, f.do(f.admin, "PATCH", "/api/v1/settings", `{"fontSize":24,"uiFont":"`+font.ID+`"}`, nil))
	if err := f.store.SetSetting("plugin.data.example", `{"content":"keep"}`); err != nil {
		t.Fatal(err)
	}
	data := exportedPackage(t, f, "settings")
	packagePath := filepath.Join(t.TempDir(), "settings.zip")
	os.WriteFile(packagePath, data, 0600)
	stage := t.TempDir()
	m, err := backup.Extract(context.Background(), packagePath, stage)
	if err != nil || m.Kind != "settings" {
		t.Fatalf("设置包无效: %v", err)
	}
	prefs, err := readPreferences(stage)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := prefs["auth.password"]; ok {
		t.Fatal("设置包不得含账户密码")
	}
	assertOK(t, f.do(f.admin, "PATCH", "/api/v1/settings", `{"fontSize":18}`, nil))
	second := append([]byte(nil), testFontData(t)...)
	second = append(second, 0)
	extra := decode[fontInfo](t, uploadTestFont(t, f, f.admin, "extra.woff2", second))
	id := stagedPackage(t, f, "settings", data)
	assertOK(t, f.do(f.admin, "POST", "/api/v1/maintenance/settings/import", `{"id":"`+id+`","confirmed":true}`, nil))
	settings := decode[map[string]json.RawMessage](t, f.do(f.admin, "GET", "/api/v1/settings", "", nil))
	if string(settings["fontSize"]) != "24" {
		t.Fatal("偏好未恢复")
	}
	fonts := decode[struct{ Fonts []fontInfo }](t, f.do(f.admin, "GET", "/api/v1/fonts", "", nil))
	if len(fonts.Fonts) != 2 {
		t.Fatalf("未保留包外字体: %+v", fonts)
	}
	assertOK(t, f.do(f.admin, "GET", "/api/v1/fonts/"+extra.ID+"/file", "", nil))
	if body := f.do(f.admin, "GET", "/api/v1/files/note.md", "", nil); body.StatusCode != 200 {
		t.Fatal("笔记被改变")
	}
	rollback, err := filepath.Glob(filepath.Join(filepath.Dir(f.root), "backups", "settings-*.zip"))
	if err != nil || len(rollback) != 1 {
		t.Fatal("未保存操作前备份")
	}
	if pending, err := backup.Pending(filepath.Dir(f.root)); err != nil || pending {
		t.Fatal("成功导入未提交恢复记录")
	}
}
func TestResetPreferencesPreservesPluginDataAndCredentials(t *testing.T) {
	f := newFixture(t)
	f.write("note.md", "source")
	f.store.SetSetting(settingsKey, `{"fontSize":24,"trashRetentionDays":0}`)
	f.store.SetSetting(pluginEnabledKey, `{"example":true}`)
	f.store.SetSetting("plugin.data.example", `{"important":"content"}`)
	if status := f.status(f.admin, "POST", "/api/v1/maintenance/settings/reset", `{"confirmed":false}`, nil); status != 400 {
		t.Fatal(status)
	}
	assertOK(t, f.do(f.admin, "POST", "/api/v1/maintenance/settings/reset", `{"confirmed":true}`, nil))
	for _, key := range []string{settingsKey, pluginEnabledKey} {
		if _, ok, err := f.store.Setting(key); err != nil || ok {
			t.Fatalf("未重置 %s", key)
		}
	}
	if value, ok, err := f.store.Setting("plugin.data.example"); err != nil || !ok || value != `{"important":"content"}` {
		t.Fatal("插件数据丢失")
	}
	assertOK(t, f.do(f.admin, "GET", "/api/v1/tree", "", nil))
}
func TestFullBackupRestoresFilesDatabaseAndInvalidatesSessions(t *testing.T) {
	f := newFixture(t)
	f.write("folder/note.md", "before ![](./assets/a.png)")
	f.write("folder/assets/a.png", "image bytes")
	f.store.SetSetting(settingsKey, `{"fontSize":24}`)
	data := exportedPackage(t, f, "full")
	archive := filepath.Join(t.TempDir(), "full.zip")
	os.WriteFile(archive, data, 0600)
	stage := t.TempDir()
	_, err := backup.Extract(context.Background(), archive, stage)
	if err != nil {
		t.Fatal(err)
	}
	if err = backup.CheckDatabase(filepath.Join(stage, "app/rawmark.db")); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	vault := filepath.Join(root, "vault")
	os.MkdirAll(vault, 0700)
	// 解包后落入目标实例，目标的环境路径与源实例不同。
	if err = backup.CopyTree(filepath.Join(stage, "vault"), vault); err != nil {
		t.Fatal(err)
	}
	if err = backup.CopyTree(filepath.Join(stage, "app"), root); err != nil {
		t.Fatal(err)
	}
	st, err := store.OpenExisting(filepath.Join(root, "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	if value, _, err := st.Setting(settingsKey); err != nil || !strings.Contains(value, "24") {
		t.Fatal("数据库快照不一致")
	}
	if err = st.ClearSessions(); err != nil {
		t.Fatal(err)
	}
	st.Close()
	bytes, err := os.ReadFile(filepath.Join(vault, "folder/note.md"))
	if err != nil || string(bytes) != "before ![](./assets/a.png)" {
		t.Fatal("笔记未原样恢复")
	}
}
func TestMaintenanceUploadsEnforceOwnershipOffsetsAndValidation(t *testing.T) {
	f := newFixture(t)
	data := exportedPackage(t, f, "settings")
	res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads", `{"kind":"settings","size":`+strconv.Itoa(len(data))+`}`, nil)
	id := decode[struct{ ID string }](t, res).ID
	if code := f.status(f.admin, "PUT", "/api/v1/maintenance/uploads/"+id, "x", map[string]string{"Upload-Offset": "1"}); code != 400 {
		t.Fatal("允许错误偏移")
	}
	if code := f.status(f.admin, "POST", "/api/v1/maintenance/uploads/"+id+"/validate", "", nil); code != 400 {
		t.Fatal("允许校验未完成上传")
	}
	other := newClient()
	assertOK(t, f.login(other, "password123"))
	if code := f.status(other, "DELETE", "/api/v1/maintenance/uploads/"+id, "", nil); code != 400 {
		t.Fatal("允许其他会话删除上传")
	}
	if code := f.status(f.admin, "POST", "/api/v1/maintenance/settings/import", `{"id":"`+id+`","confirmed":true}`, nil); code != 400 {
		t.Fatal("允许未校验应用")
	}
	assertOK(t, f.do(f.admin, "DELETE", "/api/v1/maintenance/uploads/"+id, "", nil))
}
func TestMaintenanceRequiresSessionAndClearTempPreservesData(t *testing.T) {
	f := newFixture(t)
	f.write("note.md", "keep")
	f.write("assets/image.png", "keep")
	created := decode[struct{ Token string }](t, f.do(f.admin, "POST", "/api/v1/tokens", `{"name":"test","scope":"write"}`, nil))
	for _, path := range []string{"/maintenance/export/full", "/maintenance/notes/export", "/maintenance/settings/reset", "/maintenance/temp/clear", "/maintenance/index/rebuild", "/maintenance/logs/export"} {
		if code := f.status(newClient(), "POST", "/api/v1"+path, "{}", nil); code != 401 {
			t.Fatalf("匿名可访问 %s: %d", path, code)
		}
		if code := f.status(newClient(), "POST", "/api/v1"+path, "{}", map[string]string{"Authorization": "Bearer " + created.Token}); code != 403 {
			t.Fatalf("令牌可访问 %s: %d", path, code)
		}
	}
	data := filepath.Dir(f.root)
	temp := filepath.Join(data, "temp")
	os.MkdirAll(temp, 0700)
	os.WriteFile(filepath.Join(temp, "abandoned"), []byte("abc"), 0600)
	os.MkdirAll(filepath.Join(data, "backups"), 0700)
	os.WriteFile(filepath.Join(data, "backups/keep.zip"), []byte("backup"), 0600)
	id := stagedPackage(t, f, "settings", exportedPackage(t, f, "settings"))
	result := decode[cleanupResult](t, f.do(f.admin, "POST", "/api/v1/maintenance/temp/clear", "", nil))
	if result.Files != 1 || result.Bytes != 3 || len(result.Failed) != 0 {
		t.Fatalf("清理结果错误: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(data, ".maintenance/uploads", id, "archive.zip")); err != nil {
		t.Fatal("删除了新上传")
	}
	if _, err := os.Stat(filepath.Join(data, "backups/keep.zip")); err != nil {
		t.Fatal("删除了回退备份")
	}
	assertOK(t, f.do(f.admin, "GET", "/api/v1/files/note.md", "", nil))
}
func TestSettingsPackageDatabaseFailureRollsBack(t *testing.T) {
	f := newFixture(t)
	f.store.SetSetting(settingsKey, `{"fontSize":24}`)
	data := exportedPackage(t, f, "settings")
	f.store.SetSetting(settingsKey, `{"fontSize":18}`)
	// 通过实际 SQLite 约束制造提交失败，验证备份和事务边界。
	raw, err := sql.Open("sqlite", filepath.Join(filepath.Dir(f.root), "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer raw.Close()
	_, err = raw.Exec(`CREATE TRIGGER reject_import BEFORE INSERT ON settings WHEN NEW.key='app.settings' AND NEW.value LIKE '%24%' BEGIN SELECT RAISE(ABORT,'intentional import failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	id := stagedPackage(t, f, "settings", data)
	res := f.do(f.admin, "POST", "/api/v1/maintenance/settings/import", `{"id":"`+id+`","confirmed":true}`, nil)
	if res.StatusCode != 500 {
		t.Fatalf("数据库提交故障应返回 500，实际 %d", res.StatusCode)
	}
	value, _, err := f.store.Setting(settingsKey)
	if err != nil || !strings.Contains(value, "18") {
		t.Fatal("原设置未保留")
	}
	if pending, _ := backup.Pending(filepath.Dir(f.root)); pending {
		t.Fatal("成功回退后仍有待执行记录")
	}
}

func TestMaintenanceErrorsPreserveHTTPStatus(t *testing.T) {
	t.Run("invalid archive", func(t *testing.T) {
		f := newFixture(t)
		id := uploadedPackage(t, f, "settings", []byte("not a zip"))
		res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads/"+id+"/validate", "", nil)
		defer res.Body.Close()
		var body response
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != 400 || body.Code != 40000 || !strings.Contains(body.Message, "备份内容无效") {
			t.Fatalf("无效备份响应错误: %d %+v", res.StatusCode, body)
		}
	})
	t.Run("invalid resource structure", func(t *testing.T) {
		f := newFixture(t)
		dir := t.TempDir()
		settings := filepath.Join(dir, "settings.json")
		fonts := filepath.Join(dir, "fonts-file")
		if err := os.WriteFile(settings, []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fonts, []byte("not a directory"), 0600); err != nil {
			t.Fatal(err)
		}
		archive := filepath.Join(dir, "invalid-resources.zip")
		if err := backup.Create(context.Background(), archive, "settings", []backup.Source{{Name: "settings.json", Path: settings}, {Name: "app/fonts", Path: fonts}}, nil); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(archive)
		if err != nil {
			t.Fatal(err)
		}
		id := uploadedPackage(t, f, "settings", data)
		res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads/"+id+"/validate", "", nil)
		defer res.Body.Close()
		if res.StatusCode != 400 {
			t.Fatalf("归档资源结构错误应返回 400，实际 %d", res.StatusCode)
		}
	})
	t.Run("filesystem failure", func(t *testing.T) {
		f := newFixture(t)
		if err := os.WriteFile(filepath.Join(f.server.DataDir, ".maintenance"), []byte("blocked"), 0600); err != nil {
			t.Fatal(err)
		}
		res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads", `{"kind":"settings","size":10}`, nil)
		defer res.Body.Close()
		var body response
		if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != 500 || body.Code != 50000 || body.Message != "服务器内部错误" {
			t.Fatalf("磁盘故障被当作输入错误: %d %+v", res.StatusCode, body)
		}
	})
	t.Run("maintenance contention", func(t *testing.T) {
		f := newFixture(t)
		f.server.maintenanceMu.Lock()
		defer f.server.maintenanceMu.Unlock()
		res := f.do(f.admin, "POST", "/api/v1/maintenance/uploads", `{"kind":"settings","size":10}`, nil)
		defer res.Body.Close()
		if res.StatusCode != 503 {
			t.Fatalf("维护占用应返回 503，实际 %d", res.StatusCode)
		}
	})
	t.Run("insufficient disk space", func(t *testing.T) {
		err := enoughSpace(t.TempDir(), math.MaxInt64)
		if !errors.Is(err, syscall.ENOSPC) {
			t.Fatalf("磁盘容量检查未保留 ENOSPC: %v", err)
		}
		w := httptest.NewRecorder()
		(&Server{}).maintenanceError(w, httptest.NewRequest("POST", "/api/v1/maintenance/uploads", nil), err)
		if w.Code != 503 {
			t.Fatalf("磁盘空间不足应返回 503，实际 %d", w.Code)
		}
	})
}
