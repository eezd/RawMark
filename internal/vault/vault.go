// Package vault manages the note directory: files are the source of truth, and all paths are vault-relative with "/" separators.
package vault

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"rawmark/internal/i18n"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidPath = i18n.New("invalid_path_ec93bf")
	ErrNotFound    = i18n.New("file_not_found_3703e4")
	ErrExists      = i18n.New("destination_already_exists_9511c3")
	ErrTooLarge    = i18n.New("file_is_too_large_5bfcab")
)

// ConflictError indicates a failed If-Match check; Rev is the current server revision (empty if the file does not exist).
type ConflictError struct{ Rev string }

func (e *ConflictError) Error() string { return i18n.New("version_conflict").Error() }

const (
	NoteExt   = ".md"
	AssetsExt = ".assets"
	metaDir   = ".rawmark"
	tmpPrefix = ".rawmark-tmp-"
)

type Vault struct {
	root  string // Absolute path with symlinks resolved.
	trash string
	// Serialize writes to make compound operations such as revision-check/write and moves atomic.
	mu sync.Mutex
}

type Entry struct {
	Path    string      `json:"path"`
	Dir     bool        `json:"dir"`
	Size    int64       `json:"size"`
	ModTime int64       `json:"mtime"` // Milliseconds.
	Info    fs.FileInfo `json:"-"`
	Icon    *TreeIcon   `json:"icon,omitempty"`
}

type TrashItem struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Dir       bool   `json:"dir"`
	DeletedAt int64  `json:"deletedAt"` // Milliseconds.
	// .assets directory deleted with the note, relative to the recycle-bin entry directory.
	Assets string `json:"assets,omitempty"`
}

func Open(root string) (*Vault, error) {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	real, err = filepath.Abs(real)
	if err != nil {
		return nil, err
	}
	trash := filepath.Join(real, metaDir, "trash")
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return nil, err
	}
	return &Vault{root: real, trash: trash}, nil
}

func (v *Vault) Root() string { return v.root }

// Rev is the content revision: the first eight SHA-256 bytes in hexadecimal.
func Rev(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:8])
}

// CleanPath validates client-relative paths: reject absolute paths, empty segments, "."/"..", and hidden segments starting with ".".
// Hidden segments include .rawmark metadata and .git; none are exposed through the API.
func CleanPath(p string) (string, error) {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return "", ErrInvalidPath
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return "", ErrInvalidPath
		}
	}
	return p, nil
}

func IsNote(p string) bool { return strings.HasSuffix(p, NoteExt) && len(p) > len(NoteExt) }

// AssetsDir returns the note's Typora-style image directory: a.md -> a.assets.
func AssetsDir(note string) string { return strings.TrimSuffix(note, NoteExt) + AssetsExt }

func (v *Vault) abs(rel string) (string, error) {
	rel, err := CleanPath(rel)
	if err != nil {
		return "", err
	}
	p := filepath.Join(v.root, filepath.FromSlash(rel))
	if err := v.checkInside(p); err != nil {
		return "", err
	}
	return p, nil
}

// checkInside resolves the deepest existing ancestor and ensures it stays inside the vault, preventing symlink escapes.
func (v *Vault) checkInside(p string) error {
	for cur := p; ; {
		real, err := filepath.EvalSymlinks(cur)
		if err == nil {
			if real != v.root && !strings.HasPrefix(real, v.root+string(filepath.Separator)) {
				return ErrInvalidPath
			}
			return nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return ErrInvalidPath
		}
		cur = parent
	}
}

// ---- Reading and writing ----

func (v *Vault) Read(rel string) ([]byte, string, error) {
	if !IsNote(rel) {
		return nil, "", ErrInvalidPath
	}
	p, err := v.abs(rel)
	if err != nil {
		return nil, "", err
	}
	data, err := os.ReadFile(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	return data, Rev(data), nil
}

// Stat returns regular-file or directory information, or ErrNotFound if missing.
func (v *Vault) Stat(rel string) (fs.FileInfo, error) {
	p, err := v.abs(rel)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(p)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && !info.Mode().IsRegular() && !info.IsDir()) {
		return nil, ErrNotFound
	}
	return info, err
}

// Precondition maps HTTP conditions: IfMatch requires the current revision; IfNoneMatch requires a new file; omitting both overwrites unconditionally.
type Precondition struct {
	IfMatch     string
	IfNoneMatch bool
}

func (v *Vault) Write(rel string, content []byte, pre Precondition) (string, error) {
	if !IsNote(rel) {
		return "", ErrInvalidPath
	}
	p, err := v.abs(rel)
	if err != nil {
		return "", err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	cur, err := os.ReadFile(p)
	exists := err == nil
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if pre.IfNoneMatch && exists {
		return "", ErrExists
	}
	if pre.IfMatch != "" {
		if !exists {
			return "", &ConflictError{}
		}
		if Rev(cur) != pre.IfMatch {
			return "", &ConflictError{Rev: Rev(cur)}
		}
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if err := atomicWrite(p, content); err != nil {
		return "", err
	}
	return Rev(content), nil
}

// atomicWrite writes and fsyncs a sibling temporary file before renaming it over the destination, preventing partial files.
func atomicWrite(p string, data []byte) error {
	dir := filepath.Dir(p)
	f, err := os.CreateTemp(dir, tmpPrefix+"*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // No-op after a successful rename.
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		d.Sync()
		d.Close()
	}
	return nil
}

func (v *Vault) Mkdir(rel string) error {
	p, err := v.abs(rel)
	if err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, err := os.Lstat(p); err == nil {
		return ErrExists
	}
	return os.MkdirAll(p, 0o755)
}

// OpenRaw opens a regular vault file (such as an image); the caller must close it.
func (v *Vault) OpenRaw(rel string) (*os.File, fs.FileInfo, error) {
	p, err := v.abs(rel)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, ErrNotFound
	}
	if err != nil {
		return nil, nil, err
	}
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = ErrNotFound
		}
		return nil, nil, err
	}
	return f, info, nil
}

// ---- Listing ----

// IsImage recognizes extensions supported by image management; it does not validate file contents.
func IsImage(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".apng", ".bmp", ".ico", ".tif", ".tiff":
		return true
	default:
		return false
	}
}

// Tree lists folders, notes, and images within TreeAt's hidden-path and symlink boundaries.
func (v *Vault) Tree() ([]Entry, error) {
	entries, err := v.TreeAt("")
	if err != nil {
		return nil, err
	}
	icons, err := v.readTreeIcons()
	if err != nil {
		return nil, err
	}
	visible := []Entry{}
	for _, e := range entries {
		if e.Dir {
			e.Size = 0
		}
		if e.Dir || IsImage(e.Path) || (IsNote(e.Path) && !strings.Contains(e.Path, AssetsExt+"/")) {
			if icon, ok := icons[e.Path]; ok {
				e.Icon = &icon
			}
			visible = append(visible, e)
		}
	}
	return visible, nil
}

// TreeAt recursively lists regular files and subfolders relative to the selected directory. An empty path selects the vault root; hidden entries and symlinks are not exposed.
func (v *Vault) TreeAt(rel string) ([]Entry, error) {
	root := v.root
	if rel != "" {
		var err error
		root, err = v.abs(rel)
		if err != nil {
			return nil, err
		}
	}
	entries := []Entry{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return nil
		}
		name, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		entries = append(entries, Entry{Path: filepath.ToSlash(name), Dir: info.IsDir(), Size: info.Size(), ModTime: info.ModTime().UnixMilli(), Info: info})
		return nil
	})
	return entries, err
}

// ---- Moving / renaming ----

// Move moves or renames a note, image, or folder and reports whether atomic rewriting changed the moved item's file identity.
// The note's .assets directory follows it; renaming also rewrites links to its own image directory.
func (v *Vault) Move(from, to string) (rewritten bool, err error) {
	src, err := v.abs(from)
	if err != nil {
		return false, err
	}
	dst, err := v.abs(to)
	if err != nil {
		return false, err
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return false, ErrInvalidPath
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := os.Lstat(src)
	if errors.Is(err, fs.ErrNotExist) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	isNote := !info.IsDir() && IsNote(from)
	isImage := !info.IsDir() && IsImage(from)
	validTarget := (isNote && IsNote(to)) || (isImage && strings.EqualFold(path.Ext(from), path.Ext(to)))
	if !info.IsDir() && (!info.Mode().IsRegular() || !validTarget) {
		return false, ErrInvalidPath
	}
	if _, err := os.Lstat(dst); err == nil {
		return false, ErrExists
	}
	icons, err := v.readTreeIcons()
	if err != nil {
		return false, err
	}
	movedIcons := takeTreeIcons(icons, from, info.IsDir())
	iconsChanged := len(movedIcons) > 0
	for p, icon := range movedIcons {
		icons[movedPath(p, from, to, info.IsDir())] = icon
	}
	srcAssets, dstAssets := "", ""
	if isNote {
		if st, err := os.Stat(AssetsDir(src)); err == nil && st.IsDir() {
			srcAssets, dstAssets = AssetsDir(src), AssetsDir(dst)
			if _, err := os.Lstat(dstAssets); err == nil {
				return false, ErrExists
			}
		}
	}
	if srcAssets != "" {
		attached := takeTreeIcons(icons, AssetsDir(from), true)
		iconsChanged = iconsChanged || len(attached) > 0
		for p, icon := range attached {
			icons[movedPath(p, AssetsDir(from), AssetsDir(to), true)] = icon
		}
	}
	var images []imageTransfer
	var imageTargets map[string]string
	defer func() {
		if err == nil {
			return
		}
		for _, image := range images {
			if image.removed {
				if rollback := atomicWrite(filepath.Join(v.root, filepath.FromSlash(image.source)), image.data); rollback != nil {
					err = errors.Join(err, i18n.New("could_not_roll_back_the_d7c4fc", rollback))
				}
			}
		}
		for _, image := range images {
			if image.created {
				if rollback := os.Remove(filepath.Join(v.root, filepath.FromSlash(image.target))); rollback != nil {
					err = errors.Join(err, i18n.New("could_not_remove_the_copied_e96efd", rollback))
				}
			}
		}
	}()
	if isNote && path.Dir(from) != path.Dir(to) {
		images, imageTargets, err = v.copyNoteImages(from, to)
		if err != nil {
			return false, err
		}
	}
	// Moving notes, folders, or images can change relative links between files.
	links, err := v.moveLinkChanges(from, to, info.IsDir(), srcAssets != "", imageTargets)
	if err != nil {
		return false, err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return false, err
	}
	if err := os.Rename(src, dst); err != nil {
		return false, err
	}
	writtenLinks := 0
	assetsMoved := false
	defer func() {
		if err == nil {
			return
		}
		if assetsMoved {
			if rollback := os.Rename(dstAssets, srcAssets); rollback != nil {
				err = errors.Join(err, i18n.New("could_not_roll_back_the_f89084", rollback))
			}
		}
		for _, change := range links[:writtenLinks] {
			if rollback := atomicWrite(change.path, change.before); rollback != nil {
				err = errors.Join(err, i18n.New("could_not_roll_back_note_8554a3", rollback))
			}
		}
		if rollback := os.Rename(dst, src); rollback != nil {
			err = errors.Join(err, i18n.New("could_not_roll_back_the_36ec22", rollback))
		}
	}()
	for _, change := range links {
		if err = atomicWrite(change.path, change.after); err != nil {
			return false, err
		}
		writtenLinks++
		if change.path == dst || info.IsDir() && strings.HasPrefix(change.path, dst+string(filepath.Separator)) {
			rewritten = true
		}
	}
	if srcAssets != "" {
		if err := os.Rename(srcAssets, dstAssets); err != nil {
			return false, i18n.New("could_not_move_image_folder_c39928", err)
		}
		assetsMoved = true
	}
	for i := range images {
		if images[i].removeSource {
			if err := os.Remove(filepath.Join(v.root, filepath.FromSlash(images[i].source))); err != nil {
				return false, err
			}
			images[i].removed = true
		}
	}
	if iconsChanged {
		err = v.writeTreeIcons(icons)
	}
	return rewritten, err
}

// ---- Recycle bin ----

func newTrashID() string {
	var b [4]byte
	rand.Read(b[:])
	return time.Now().UTC().Format("20060102T150405.000") + "-" + hex.EncodeToString(b[:])
}

var trashIDPattern = regexp.MustCompile(`^\d{8}T\d{6}\.\d{3}-[0-9a-f]{8}$`)

// Delete moves a note (with .assets), image, or folder to the recycle bin.
func (v *Vault) Delete(rel string) (TrashItem, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.deleteLocked(rel)
}

func (v *Vault) deleteLocked(rel string) (item TrashItem, err error) {
	p, err := v.abs(rel)
	if err != nil {
		return TrashItem{}, err
	}
	info, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return TrashItem{}, ErrNotFound
	}
	if err != nil {
		return TrashItem{}, err
	}
	if !info.IsDir() && (!info.Mode().IsRegular() || (!IsNote(rel) && !IsImage(rel))) {
		return TrashItem{}, ErrInvalidPath
	}
	item = TrashItem{ID: newTrashID(), Path: rel, Dir: info.IsDir(), DeletedAt: time.Now().UnixMilli()}
	if !item.Dir && IsNote(rel) {
		st, statErr := os.Stat(AssetsDir(p))
		if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
			return TrashItem{}, statErr
		}
		if statErr == nil && st.IsDir() {
			item.Assets = filepath.Base(AssetsDir(p))
		}
	}
	icons, err := v.readTreeIcons()
	if err != nil {
		return TrashItem{}, err
	}
	metadata := trashMetadata{TrashItem: item, Icons: takeTreeIcons(icons, rel, item.Dir)}
	if item.Assets != "" {
		for p, icon := range takeTreeIcons(icons, AssetsDir(rel), true) {
			metadata.Icons[p] = icon
		}
	}
	dir := filepath.Join(v.trash, item.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return TrashItem{}, err
	}
	noteMoved, assetsMoved := false, false
	defer func() {
		if err == nil {
			return
		}
		rollbackFailed := false
		if assetsMoved {
			if rollback := os.Rename(filepath.Join(dir, item.Assets), AssetsDir(p)); rollback != nil {
				err = errors.Join(err, i18n.New("could_not_roll_back_trashed_b37d4f", rollback))
				rollbackFailed = true
			}
		}
		if noteMoved {
			if rollback := os.Rename(filepath.Join(dir, filepath.Base(p)), p); rollback != nil {
				err = errors.Join(err, i18n.New("could_not_roll_back_trashed_3758a4", rollback))
				rollbackFailed = true
			}
		}
		// Retain directories and metadata on rollback failure instead of deleting the last recovery information.
		if !rollbackFailed {
			if cleanup := os.RemoveAll(dir); cleanup != nil {
				err = errors.Join(err, cleanup)
			}
		}
	}()
	meta, _ := json.Marshal(metadata)
	if err = atomicWrite(filepath.Join(dir, "meta.json"), meta); err != nil {
		return item, err
	}
	if err = os.Rename(p, filepath.Join(dir, filepath.Base(p))); err != nil {
		return item, err
	}
	noteMoved = true
	if item.Assets != "" {
		if err = os.Rename(AssetsDir(p), filepath.Join(dir, item.Assets)); err != nil {
			return item, i18n.New("could_not_move_image_folder_7c4620", err)
		}
	}
	assetsMoved = item.Assets != ""
	if len(metadata.Icons) > 0 {
		err = v.writeTreeIcons(icons)
	}
	return item, err
}

func (v *Vault) readTrashItem(id string) (TrashItem, error) {
	metadata, err := v.readTrashMetadata(id)
	return metadata.TrashItem, err
}

func (v *Vault) readTrashMetadata(id string) (trashMetadata, error) {
	if !trashIDPattern.MatchString(id) {
		return trashMetadata{}, ErrInvalidPath
	}
	data, err := os.ReadFile(filepath.Join(v.trash, id, "meta.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return trashMetadata{}, ErrNotFound
	}
	if err != nil {
		return trashMetadata{}, err
	}
	var metadata trashMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		return trashMetadata{}, i18n.New("trash_item_s_has_damaged_ba382a", id, err)
	}
	if _, err := CleanPath(metadata.Path); err != nil || metadata.ID != id || metadata.DeletedAt <= 0 || (metadata.Assets != "" && metadata.Assets != filepath.Base(AssetsDir(metadata.Path))) {
		return trashMetadata{}, i18n.New("trash_item_s_has_invalid_006492", id)
	}
	for p, icon := range metadata.Icons {
		if _, err := CleanPath(p); err != nil || !icon.valid() || !(p == metadata.Path || metadata.Dir && strings.HasPrefix(p, metadata.Path+"/") || metadata.Assets != "" && (p == AssetsDir(metadata.Path) || strings.HasPrefix(p, AssetsDir(metadata.Path)+"/"))) {
			return trashMetadata{}, i18n.New("trash_item_s_has_damaged_856237", id)
		}
	}
	return metadata, nil
}

func (v *Vault) TrashList() ([]TrashItem, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	dirs, err := os.ReadDir(v.trash)
	if err != nil {
		return nil, err
	}
	items := []TrashItem{}
	for _, d := range dirs {
		item, err := v.readTrashItem(d.Name())
		if errors.Is(err, ErrInvalidPath) || errors.Is(err, ErrNotFound) {
			continue // A directory not created by this application, or an incomplete deletion entry.
		}
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].DeletedAt > items[j].DeletedAt })
	return items, nil
}

func (v *Vault) Restore(id string) (item TrashItem, err error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	metadata, err := v.readTrashMetadata(id)
	item = metadata.TrashItem
	if err != nil {
		return TrashItem{}, err
	}
	dst, err := v.abs(item.Path)
	if err != nil {
		return TrashItem{}, err
	}
	icons, err := v.readTreeIcons()
	if err != nil {
		return TrashItem{}, err
	}
	for p, icon := range metadata.Icons {
		icons[p] = icon
	}
	if _, err := os.Lstat(dst); err == nil {
		return TrashItem{}, ErrExists
	}
	if item.Assets != "" {
		if _, err := os.Lstat(AssetsDir(dst)); err == nil {
			return TrashItem{}, ErrExists
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return TrashItem{}, err
	}
	dir := filepath.Join(v.trash, id)
	if err := os.Rename(filepath.Join(dir, filepath.Base(dst)), dst); err != nil {
		return TrashItem{}, err
	}
	assetsMoved, cleaning := false, false
	defer func() {
		if err == nil {
			return
		}
		if cleaning {
			// Cleanup may have deleted metadata; recreate recovery information before undoing this move.
			if rollback := os.MkdirAll(dir, 0o755); rollback != nil {
				err = errors.Join(err, rollback)
				return
			}
			meta, _ := json.Marshal(metadata)
			if rollback := atomicWrite(filepath.Join(dir, "meta.json"), meta); rollback != nil {
				err = errors.Join(err, rollback)
			}
		}
		if assetsMoved {
			if rollback := os.Rename(AssetsDir(dst), filepath.Join(dir, item.Assets)); rollback != nil {
				err = errors.Join(err, i18n.New("could_not_roll_back_restored_952073", rollback))
			}
		}
		if rollback := os.Rename(dst, filepath.Join(dir, filepath.Base(dst))); rollback != nil {
			err = errors.Join(err, i18n.New("could_not_roll_back_restored_16b803", rollback))
		}
	}()
	if item.Assets != "" {
		if err := os.Rename(filepath.Join(dir, item.Assets), AssetsDir(dst)); err != nil {
			return item, i18n.New("could_not_restore_image_folder_f6e087", err)
		}
		assetsMoved = true
	}
	cleaning = true
	if err = os.RemoveAll(dir); err != nil {
		return item, err
	}
	if len(metadata.Icons) > 0 {
		err = v.writeTreeIcons(icons)
	}
	return item, err
}

func (v *Vault) Purge(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	metadata, err := v.readTrashMetadata(id)
	if err != nil {
		return err
	}
	return v.purgeTrashItemLocked(metadata)
}

// ---- Resources ----

var extPattern = regexp.MustCompile(`^\.[a-z0-9]{1,8}$`)

// SaveAsset stores an upload in the note's sibling assets directory, named by content hash (identical contents are stored once),
// and returns a relative link ready for Markdown.
func (v *Vault) SaveAsset(note, origName string, r io.Reader, limit int64) (string, error) {
	if !IsNote(note) {
		return "", ErrInvalidPath
	}
	if _, err := CleanPath(note); err != nil {
		return "", err
	}
	return v.saveAssetAt(path.Join(path.Dir(note), "assets"), origName, r, limit)
}

// SaveFolderAsset uploads to the current folder's shared assets directory for image management, using hash deduplication.
func (v *Vault) SaveFolderAsset(folder, origName string, r io.Reader, limit int64) (string, error) {
	if !IsImage(origName) {
		return "", i18n.New("w_choose_an_image_file_544069", ErrInvalidPath)
	}
	if folder != "" {
		info, err := v.Stat(folder)
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return "", ErrInvalidPath
		}
	}
	return v.saveAssetAt(path.Join(folder, "assets"), origName, r, limit)
}

func (v *Vault) saveAssetAt(relativeDir, origName string, r io.Reader, limit int64) (string, error) {
	dir, err := v.abs(relativeDir)
	if err != nil {
		return "", err
	}
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return "", err
	}
	if int64(len(data)) > limit {
		return "", ErrTooLarge
	}
	name := assetName(data, origName)
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := v.checkInside(dir); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	target, exists, err := v.assetDestination(relativeDir, name, data)
	if err != nil {
		return "", err
	}
	if !exists {
		if err := atomicWrite(filepath.Join(v.root, filepath.FromSlash(target)), data); err != nil {
			return "", err
		}
	}
	return "./" + EscapeLinkPath(path.Base(relativeDir)) + "/" + EscapeLinkPath(path.Base(target)), nil
}

// Image management permits replacement, so filenames do not guarantee unchanged contents; reuse only regular files with matching contents.
func (v *Vault) assetDestination(dir, name string, data []byte) (string, bool, error) {
	base, ext := strings.TrimSuffix(name, path.Ext(name)), path.Ext(name)
	for i := 0; ; i++ {
		candidate := name
		if i > 0 {
			candidate = fmt.Sprintf("%s-%d%s", base, i, ext)
		}
		rel := path.Join(dir, candidate)
		full, err := v.abs(rel)
		if err != nil {
			return "", false, err
		}
		info, err := os.Lstat(full)
		if errors.Is(err, fs.ErrNotExist) {
			return rel, false, nil
		}
		if err != nil {
			return "", false, err
		}
		if !info.Mode().IsRegular() {
			return "", false, ErrInvalidPath
		}
		existing, err := os.ReadFile(full)
		if err != nil {
			return "", false, err
		}
		if bytes.Equal(existing, data) {
			return rel, true, nil
		}
	}
}

func assetName(data []byte, origName string) string {
	ext := strings.ToLower(filepath.Ext(origName))
	if !extPattern.MatchString(ext) {
		ext = sniffExt(data)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:8]) + ext
}

func sniffExt(data []byte) string {
	switch http.DetectContentType(data) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/gif":
		return ".gif"
	case "image/webp":
		return ".webp"
	default:
		return ".bin"
	}
}

// EscapeLinkPath escapes only characters that break Markdown link destinations, preserving Unicode such as Chinese to match Typora.
func EscapeLinkPath(s string) string {
	return linkEscaper.Replace(s)
}

var linkEscaper = strings.NewReplacer("%", "%25", "&", "%26", "#", "%23", "?", "%3F", " ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E")
