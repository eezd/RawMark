package api

import (
	"net/http"
	"rawmark/internal/store"
	"rawmark/internal/vault"
	"testing"
	"time"
)

func TestImageCleanupHonorsShareExpiryAndReferences(t *testing.T) {
	f := newFixture(t)
	f.write("assets/active.png", "active")
	f.write("assets/expired.png", "expired")
	f.write("assets/used.png", "used")
	f.write("note.md", "[image](assets/used.png)")
	for _, share := range []store.Share{
		{Token: "active", Items: []store.ShareItem{{ID: 0, Path: "assets/active.png"}}, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()},
		{Token: "expired", Items: []store.ShareItem{{ID: 0, Path: "assets/expired.png"}}, ExpiresAt: time.Now().Add(-time.Hour).UnixMilli()},
	} {
		if err := f.store.CreateShare(share); err != nil {
			t.Fatal(err)
		}
	}
	if code := f.status(newClient(), "POST", "/api/v1/assets/cleanup", `{"paths":["assets/expired.png"]}`, nil); code != http.StatusUnauthorized {
		t.Fatal(code)
	}
	result := decode[vault.CleanupResult](t, f.do(f.admin, "POST", "/api/v1/assets/cleanup", `{"paths":["assets/active.png","assets/expired.png","assets/used.png"]}`, nil))
	if len(result.Deleted) != 1 || result.Deleted[0].Path != "assets/expired.png" || len(result.Skipped) != 2 {
		t.Fatalf("引用或分享保护不符：%+v", result)
	}
	if code := f.status(newClient(), "GET", "/api/v1/metadata", "", nil); code != http.StatusUnauthorized {
		t.Fatal(code)
	}
}
