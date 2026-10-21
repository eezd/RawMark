package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMigrateSingleSharesAndPreserveLinks(t *testing.T) {
	file := filepath.Join(t.TempDir(), "app.db")
	legacy, err := sql.Open("sqlite", file)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`CREATE TABLE shares(token TEXT PRIMARY KEY,path TEXT NOT NULL,password_hash TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX shares_path ON shares(path);
 INSERT INTO shares VALUES ('old-token','资料/原文.md','hash',123,456);`)
	if err != nil {
		t.Fatal(err)
	}
	legacy.Close()
	st, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	sh, ok, err := st.GetShare("old-token")
	if err != nil || !ok || sh.Path != "资料/原文.md" || len(sh.Items) != 1 || sh.Items[0].ID != 0 || sh.PasswordHash != "hash" || sh.CreatedAt != 123 || sh.ExpiresAt != 456 {
		t.Fatalf("迁移改变了旧分享：%+v %v", sh, err)
	}
	if err := st.MoveShares("资料", "归档"); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st, err = Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	sh, ok, err = st.GetShare("old-token")
	if err != nil || !ok || sh.Path != "归档/原文.md" {
		t.Fatalf("重启或移动未保留链接：%+v %v", sh, err)
	}
	if _, err := st.DeleteShare(sh.Token); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := st.db.QueryRow(`SELECT count(*) FROM share_items`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("撤销未清理主体：%d %v", count, err)
	}
}
