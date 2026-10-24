package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRemoveSharingPreservesApplicationData(t *testing.T) {
	script, err := os.ReadFile("../../scripts/remove-sharing.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, layout := range []string{"current", "legacy", "fresh"} {
		t.Run(layout, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "rawmark.db")
			st, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { st.Close() })
			if _, err := st.db.Exec(`
INSERT INTO settings VALUES ('auth.password','password-hash'), ('plugin.setting','keep'),
 ('share.secret','old-secret'),
 ('app.settings','{"fontSize":18,"shortcuts":{"note.share":["Alt+S"],"app.shares":[],"note.open":["Ctrl+O"],"plugin.command":[]},"plugin.data":{"keep":true}}');
INSERT INTO sessions VALUES ('session-hash',123,456);
INSERT INTO api_tokens VALUES ('token-id','automation','token-hash','read',123,456);`); err != nil {
				t.Fatal(err)
			}
			switch layout {
			case "current":
				_, err = st.db.Exec(`CREATE TABLE shares(token TEXT PRIMARY KEY,password_hash TEXT,created_at INTEGER,expires_at INTEGER);
CREATE TABLE share_items(share_token TEXT REFERENCES shares(token),item_id INTEGER,path TEXT);
CREATE INDEX share_items_path ON share_items(path);
INSERT INTO shares VALUES ('old-token','hash',123,0);
INSERT INTO share_items VALUES ('old-token',0,'note.md');`)
			case "legacy":
				_, err = st.db.Exec(`CREATE TABLE shares(token TEXT PRIMARY KEY,path TEXT,password_hash TEXT,created_at INTEGER,expires_at INTEGER);
CREATE INDEX shares_path ON shares(path);
INSERT INTO shares VALUES ('old-token','note.md','hash',123,0);`)
			}
			if err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if _, err := st.db.Exec(string(script)); err != nil {
					t.Fatal(err)
				}
			}
			if err := st.Close(); err != nil {
				t.Fatal(err)
			}
			st, err = Open(path)
			if err != nil {
				t.Fatal(err)
			}
			var remaining int
			if err := st.db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name IN ('shares','share_items','share_items_path','shares_path')`).Scan(&remaining); err != nil || remaining != 0 {
				t.Fatalf("重启后不应创建分享结构：%d %v", remaining, err)
			}
			if _, ok, err := st.Setting("share.secret"); err != nil || ok {
				t.Fatalf("分享密钥未清除：%v", err)
			}
			for key, want := range map[string]string{
				"auth.password": "password-hash", "plugin.setting": "keep",
				"app.settings": `{"fontSize":18,"shortcuts":{"note.open":["Ctrl+O"],"plugin.command":[]},"plugin.data":{"keep":true}}`,
			} {
				if got, ok, err := st.Setting(key); err != nil || !ok || got != want {
					t.Fatalf("非分享设置被改变：%s %v", key, err)
				}
			}
			var sessions, tokens int
			if err := st.db.QueryRow(`SELECT count(*) FROM sessions WHERE token_hash='session-hash' AND created_at=123 AND expires_at=456`).Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if err := st.db.QueryRow(`SELECT count(*) FROM api_tokens WHERE id='token-id' AND name='automation' AND token_hash='token-hash' AND scope='read' AND created_at=123 AND last_used_at=456`).Scan(&tokens); err != nil || sessions != 1 || tokens != 1 {
				t.Fatalf("会话或 API 令牌被改变：%d %d %v", sessions, tokens, err)
			}
		})
	}
}

func TestRemoveSharingRollsBackOnInvalidSettings(t *testing.T) {
	st, err := Open(filepath.Join(t.TempDir(), "rawmark.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.db.Exec(`CREATE TABLE shares(token TEXT); INSERT INTO shares VALUES ('old-token'); INSERT INTO settings VALUES ('share.secret','old-secret'),('app.settings','invalid-json');`); err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile("../../scripts/remove-sharing.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.db.Exec(string(script)); err == nil {
		t.Fatal("设置损坏时必须报告错误")
	}
	if _, err := st.db.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := st.db.QueryRow(`SELECT count(*) FROM shares WHERE token='old-token'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("失败后分享数据未恢复：%v", err)
	}
	if got, ok, err := st.Setting("share.secret"); err != nil || !ok || got != "old-secret" {
		t.Fatalf("失败后分享密钥未恢复：%v", err)
	}
}
