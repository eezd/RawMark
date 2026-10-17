// Package vault 管理笔记仓库目录：文件即真源，所有路径以仓库根为基准、使用 "/" 分隔。
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
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var (
	ErrInvalidPath = errors.New("非法路径")
	ErrNotFound    = errors.New("文件不存在")
	ErrExists      = errors.New("目标已存在")
	ErrTooLarge    = errors.New("文件过大")
)

// ConflictError 表示 If-Match 校验失败，Rev 为服务端当前版本（文件不存在时为空）
type ConflictError struct{ Rev string }

func (e *ConflictError) Error() string { return "版本冲突" }

const (
	NoteExt = ".md"
	// 加密笔记：内容为浏览器端加密的信封，服务端只做不透明存储
	EncryptedNoteExt = ".md.enc"
	AssetsExt        = ".assets"
	// 加密笔记的图片（密文）统一使用此扩展名
	encryptedAssetExt = ".enc"
	metaDir           = ".rawmark"
	keyringFile       = "keyring.json"
	tmpPrefix         = ".rawmark-tmp-"
)

type Vault struct {
	root  string // 已解析符号链接的绝对路径
	trash string
	// 串行化所有写操作，保证"检查版本 + 写入"、移动等复合操作的原子性
	mu sync.Mutex
}

type Entry struct {
	Path    string `json:"path"`
	Dir     bool   `json:"dir"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"mtime"` // 毫秒
}

type TrashItem struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Dir       bool   `json:"dir"`
	DeletedAt int64  `json:"deletedAt"` // 毫秒
	// 随笔记一起删除的 .assets 目录名（相对回收站条目目录）
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

// Rev 为内容版本号：sha256 前 8 字节的十六进制
func Rev(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:8])
}

// CleanPath 校验客户端传入的相对路径：不允许绝对路径、空段、"."/".." 段以及以 "." 开头的隐藏段
// （隐藏段包括 .rawmark 元数据目录与 .git 等，一律不经 API 暴露）
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

func IsNote(p string) bool { return noteBase(p) != "" }

func IsEncrypted(p string) bool { return strings.HasSuffix(p, EncryptedNoteExt) }

// noteBase 去掉笔记扩展名（.md 或 .md.enc）；不是笔记时返回空串
func noteBase(p string) string {
	for _, ext := range []string{EncryptedNoteExt, NoteExt} {
		if strings.HasSuffix(p, ext) && len(p) > len(ext) && !strings.HasSuffix(p, "/"+ext) {
			return strings.TrimSuffix(p, ext)
		}
	}
	return ""
}

// twin 返回同名的另一种笔记：a.md <-> a.md.enc。二者共用 a.assets，不允许同时存在
func twin(note string) string {
	if IsEncrypted(note) {
		return noteBase(note) + NoteExt
	}
	return noteBase(note) + EncryptedNoteExt
}

// assetsDir 返回笔记对应的 Typora 风格图片目录：a.md、a.md.enc -> a.assets
func assetsDir(note string) string { return noteBase(note) + AssetsExt }

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

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

// checkInside 确认路径最深的已存在祖先在解析符号链接后仍位于仓库内，防止经符号链接逃逸
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

func (v *Vault) rel(abs string) string {
	r, _ := filepath.Rel(v.root, abs)
	return filepath.ToSlash(r)
}

// ---- 读写 ----

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

// Precondition 对应 HTTP 条件请求：IfMatch 要求当前版本一致，IfNoneMatch 要求文件尚不存在；都为空则无条件覆盖
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
	if !exists(p) && exists(twin(p)) {
		return "", ErrExists
	}
	return writeChecked(p, content, pre)
}

// writeChecked 按前置条件写入文件，调用方须持有 v.mu
func writeChecked(p string, content []byte, pre Precondition) (string, error) {
	cur, err := os.ReadFile(p)
	found := err == nil
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if pre.IfNoneMatch && found {
		return "", ErrExists
	}
	if pre.IfMatch != "" {
		if !found {
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

// atomicWrite 先写同目录临时文件并 fsync，再 rename 覆盖，保证不会留下写了一半的文件
func atomicWrite(p string, data []byte) error {
	dir := filepath.Dir(p)
	f, err := os.CreateTemp(dir, tmpPrefix+"*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp) // rename 成功后为空操作
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

// OpenRaw 打开仓库内的普通文件（图片等资源），调用方负责关闭
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

// ---- 列表 ----

// skipName 判断目录树中不展示的条目：隐藏文件/目录（含临时文件）与 .assets 图片目录
func skipName(name string, dir bool) bool {
	return strings.HasPrefix(name, ".") || (dir && strings.HasSuffix(name, AssetsExt))
}

// Tree 列出所有文件夹与 .md 笔记
func (v *Vault) Tree() ([]Entry, error) {
	entries := []Entry{}
	err := filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == v.root {
			return nil
		}
		if skipName(d.Name(), d.IsDir()) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() && !IsNote(d.Name()) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		e := Entry{Path: v.rel(p), Dir: d.IsDir(), ModTime: info.ModTime().UnixMilli()}
		if !e.Dir {
			e.Size = info.Size()
		}
		entries = append(entries, e)
		return nil
	})
	return entries, err
}

// ---- 移动 / 重命名 ----

// Move 移动或重命名笔记/文件夹。笔记的 .assets 目录随之移动；笔记改名时同步改写正文中指向自身图片目录的链接
// （加密笔记的正文服务端无法改写，由浏览器解密后处理）。不能借移动在普通笔记与加密笔记之间转换
func (v *Vault) Move(from, to string) error {
	src, err := v.abs(from)
	if err != nil {
		return err
	}
	dst, err := v.abs(to)
	if err != nil {
		return err
	}
	if from == to || strings.HasPrefix(to, from+"/") {
		return ErrInvalidPath
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := os.Lstat(src)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	isNote := !info.IsDir()
	if isNote && (!IsNote(from) || !IsNote(to) || IsEncrypted(from) != IsEncrypted(to)) {
		return ErrInvalidPath
	}
	if exists(dst) || (isNote && exists(twin(dst))) {
		return ErrExists
	}
	srcAssets, dstAssets := "", ""
	if isNote {
		if st, err := os.Stat(assetsDir(src)); err == nil && st.IsDir() {
			srcAssets, dstAssets = assetsDir(src), assetsDir(dst)
			if _, err := os.Lstat(dstAssets); err == nil {
				return ErrExists
			}
		}
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	if srcAssets != "" {
		if err := os.Rename(srcAssets, dstAssets); err != nil {
			return fmt.Errorf("移动图片目录失败: %w", err)
		}
		oldBase := path.Base(noteBase(from))
		newBase := path.Base(noteBase(to))
		if oldBase != newBase && !IsEncrypted(to) {
			data, err := os.ReadFile(dst)
			if err != nil {
				return err
			}
			if out := RewriteAssetLinks(data, oldBase, newBase); !bytes.Equal(out, data) {
				return atomicWrite(dst, out)
			}
		}
	}
	return nil
}

// ---- 回收站 ----

func newTrashID() string {
	var b [4]byte
	rand.Read(b[:])
	return time.Now().UTC().Format("20060102T150405.000") + "-" + hex.EncodeToString(b[:])
}

var trashIDPattern = regexp.MustCompile(`^\d{8}T\d{6}\.\d{3}-[0-9a-f]{8}$`)

// Delete 把笔记（连同 .assets）或文件夹移入回收站
func (v *Vault) Delete(rel string) (TrashItem, error) {
	p, err := v.abs(rel)
	if err != nil {
		return TrashItem{}, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return TrashItem{}, ErrNotFound
	}
	if err != nil {
		return TrashItem{}, err
	}
	if !info.IsDir() && !IsNote(rel) {
		return TrashItem{}, ErrInvalidPath
	}
	item := TrashItem{ID: newTrashID(), Path: rel, Dir: info.IsDir(), DeletedAt: time.Now().UnixMilli()}
	dir := filepath.Join(v.trash, item.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return TrashItem{}, err
	}
	if err := os.Rename(p, filepath.Join(dir, filepath.Base(p))); err != nil {
		os.Remove(dir)
		return TrashItem{}, err
	}
	if !item.Dir {
		if st, err := os.Stat(assetsDir(p)); err == nil && st.IsDir() {
			item.Assets = filepath.Base(assetsDir(p))
			if err := os.Rename(assetsDir(p), filepath.Join(dir, item.Assets)); err != nil {
				return TrashItem{}, fmt.Errorf("移动图片目录到回收站失败: %w", err)
			}
		}
	}
	meta, _ := json.Marshal(item)
	return item, atomicWrite(filepath.Join(dir, "meta.json"), meta)
}

func (v *Vault) readTrashItem(id string) (TrashItem, error) {
	if !trashIDPattern.MatchString(id) {
		return TrashItem{}, ErrInvalidPath
	}
	data, err := os.ReadFile(filepath.Join(v.trash, id, "meta.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return TrashItem{}, ErrNotFound
	}
	if err != nil {
		return TrashItem{}, err
	}
	var item TrashItem
	if err := json.Unmarshal(data, &item); err != nil {
		return TrashItem{}, fmt.Errorf("回收站条目 %s 元数据损坏: %w", id, err)
	}
	return item, nil
}

func (v *Vault) TrashList() ([]TrashItem, error) {
	dirs, err := os.ReadDir(v.trash)
	if err != nil {
		return nil, err
	}
	items := []TrashItem{}
	for _, d := range dirs {
		item, err := v.readTrashItem(d.Name())
		if errors.Is(err, ErrInvalidPath) || errors.Is(err, ErrNotFound) {
			continue // 非本程序创建的目录或删除未完成的条目
		}
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].DeletedAt > items[j].DeletedAt })
	return items, nil
}

func (v *Vault) Restore(id string) (TrashItem, error) {
	item, err := v.readTrashItem(id)
	if err != nil {
		return TrashItem{}, err
	}
	dst, err := v.abs(item.Path)
	if err != nil {
		return TrashItem{}, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if exists(dst) || (!item.Dir && exists(twin(dst))) {
		return TrashItem{}, ErrExists
	}
	if item.Assets != "" {
		if _, err := os.Lstat(assetsDir(dst)); err == nil {
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
	if item.Assets != "" {
		if err := os.Rename(filepath.Join(dir, item.Assets), assetsDir(dst)); err != nil {
			return TrashItem{}, fmt.Errorf("恢复图片目录失败: %w", err)
		}
	}
	return item, os.RemoveAll(dir)
}

func (v *Vault) Purge(id string) error {
	if _, err := v.readTrashItem(id); err != nil {
		return err
	}
	return os.RemoveAll(filepath.Join(v.trash, id))
}

// ---- 资源 ----

var extPattern = regexp.MustCompile(`^\.[a-z0-9]{1,8}$`)

// SaveAsset 把上传的文件存入笔记的 .assets 目录，以内容哈希命名（相同内容只存一份），
// 返回可直接写入 Markdown 的相对链接
func (v *Vault) SaveAsset(note, origName string, r io.Reader, limit int64) (string, error) {
	if !IsNote(note) {
		return "", ErrInvalidPath
	}
	p, err := v.abs(note)
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
	ext := strings.ToLower(filepath.Ext(origName))
	if IsEncrypted(note) {
		ext = encryptedAssetExt
	} else if !extPattern.MatchString(ext) {
		ext = sniffExt(data)
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:8]) + ext
	dir := assetsDir(p)
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	target := filepath.Join(dir, name)
	if _, err := os.Stat(target); errors.Is(err, fs.ErrNotExist) {
		if err := atomicWrite(target, data); err != nil {
			return "", err
		}
	} else if err != nil {
		return "", err
	}
	return EscapeLinkPath(path.Base(assetsDir(note))) + "/" + name, nil
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

// EscapeLinkPath 只转义会破坏 Markdown 链接目标的字符，中文等保持原样（与 Typora 写法一致）
func EscapeLinkPath(s string) string {
	return linkEscaper.Replace(s)
}

var linkEscaper = strings.NewReplacer(" ", "%20", "(", "%28", ")", "%29", "<", "%3C", ">", "%3E")

// DeleteAsset 永久删除笔记 .assets 目录中的一个文件。用于加密/取消加密笔记后清理转换前的图片：
// 加密前的明文图片不应留在回收站中
func (v *Vault) DeleteAsset(rel string) error {
	if !strings.HasSuffix(path.Dir(rel), AssetsExt) {
		return ErrInvalidPath
	}
	p, err := v.abs(rel)
	if err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	info, err := os.Lstat(p)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return ErrInvalidPath
	}
	return os.Remove(p)
}

// ---- 加密 ----

// Convert 在普通笔记与同名加密笔记之间转换：写入 to 并永久删除 from（明文不进回收站）。
// pre 校验的是 from 的版本，确保转换的是最新内容
func (v *Vault) Convert(from, to string, content []byte, pre Precondition) (string, error) {
	if !IsNote(from) || twin(from) != to {
		return "", ErrInvalidPath
	}
	src, err := v.abs(from)
	if err != nil {
		return "", err
	}
	dst, err := v.abs(to)
	if err != nil {
		return "", err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	cur, err := os.ReadFile(src)
	if errors.Is(err, fs.ErrNotExist) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if pre.IfMatch != "" && Rev(cur) != pre.IfMatch {
		return "", &ConflictError{Rev: Rev(cur)}
	}
	if exists(dst) {
		return "", ErrExists
	}
	if err := atomicWrite(dst, content); err != nil {
		return "", err
	}
	if err := os.Remove(src); err != nil {
		return "", err
	}
	return Rev(content), nil
}

// ReadKeyring 读取加密密钥环（被加密密码包裹的主密钥，浏览器端生成和解开）；尚未设置时返回 ErrNotFound
func (v *Vault) ReadKeyring() ([]byte, string, error) {
	data, err := os.ReadFile(filepath.Join(v.root, metaDir, keyringFile))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	return data, Rev(data), nil
}

// WriteKeyring 写入密钥环。首次设置用 IfNoneMatch，修改加密密码用 IfMatch，防止覆盖另一端的修改
func (v *Vault) WriteKeyring(data []byte, pre Precondition) (string, error) {
	if !json.Valid(data) {
		return "", ErrInvalidPath
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return writeChecked(filepath.Join(v.root, metaDir, keyringFile), data, pre)
}
