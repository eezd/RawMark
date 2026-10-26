package api

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"rawmark/internal/i18n"
	"syscall"
	"time"

	"rawmark/internal/vault"
)

var (
	errImageAddress = i18n.New("image_url_must_be_a_391763")
	errImageType    = i18n.New("only_png_jpeg_gif_and_a413cf")
)

var blockedImageNetworks = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001::/23"),
	netip.MustParsePrefix("2001:db8::/32"),
	netip.MustParsePrefix("2002::/16"),
	netip.MustParsePrefix("3fff::/20"),
}

func publicImageIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	// 不接受 IPv6 地址转换前缀，避免其中嵌入的 IPv4 地址访问内网。
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, prefix := range blockedImageNetworks {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

func checkImageURL(u *url.URL) error {
	if (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return errImageAddress
	}
	return nil
}

var remoteImageClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		// 不使用环境代理，确保每个实际连接都经过目标地址校验。
		DialContext: (&net.Dialer{
			Timeout: 5 * time.Second,
			ControlContext: func(_ context.Context, _, address string, _ syscall.RawConn) error {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				ip, err := netip.ParseAddr(host)
				if err != nil || !publicImageIP(ip) {
					return errImageAddress
				}
				local, err := net.InterfaceAddrs()
				if err != nil {
					return err
				}
				for _, addr := range local {
					prefix, err := netip.ParsePrefix(addr.String())
					if err != nil {
						return err
					}
					if ip.Unmap() == prefix.Addr().Unmap() {
						return errImageAddress
					}
				}
				return nil
			},
		}).DialContext,
		TLSHandshakeTimeout: 5 * time.Second,
		IdleConnTimeout:     30 * time.Second,
		ForceAttemptHTTP2:   true,
	},
	CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return i18n.New("too_many_redirects_from_the_6738ba")
		}
		r.Header.Del("Referer")
		return checkImageURL(r.URL)
	},
}

// readImageDownload 按实际文件签名确定类型，不信任来源的扩展名或 Content-Type。
func readImageDownload(body io.Reader) ([]byte, string, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxAssetBytes+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > maxAssetBytes {
		return nil, "", vault.ErrTooLarge
	}
	var ext string
	switch http.DetectContentType(data) {
	case "image/png":
		ext = ".png"
	case "image/jpeg":
		ext = ".jpg"
	case "image/gif":
		ext = ".gif"
	case "image/webp":
		ext = ".webp"
	default:
		return nil, "", errImageType
	}
	return data, ext, nil
}

func (s *Server) importAsset(w http.ResponseWriter, r *http.Request) {
	var body struct{ URL string }
	if !readJSON(w, r, &body) {
		return
	}
	u, err := url.Parse(body.URL)
	if err != nil || checkImageURL(u) != nil {
		writeError(w, 400, i18n.RenderError(errImageAddress, responseLocale(w)))
		return
	}
	note := r.URL.Query().Get("note")
	if !vault.IsNote(note) {
		writeError(w, 400, message(w, "invalid_note_path_be69bd"))
		return
	}
	if _, err := s.vault.Stat(note); err != nil {
		vaultError(w, r, err)
		return
	}
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			timer := time.NewTimer(time.Second)
			select {
			case <-r.Context().Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
		if err != nil {
			writeError(w, 400, i18n.RenderError(errImageAddress, responseLocale(w)))
			return
		}
		res, err := remoteImageClient.Do(req)
		if err != nil {
			var timeout net.Error
			if attempt == 0 && errors.As(err, &timeout) && timeout.Timeout() && r.Context().Err() == nil {
				continue
			}
			if errors.Is(err, errImageAddress) {
				writeError(w, 400, i18n.RenderError(errImageAddress, responseLocale(w)))
				return
			}
			// url.Error 含完整来源 URL，其中可能有临时签名，日志只保留底层原因。
			var urlError *url.Error
			if errors.As(err, &urlError) {
				err = urlError.Err
			}
			slog.Error("下载图片失败", "err", err)
			writeError(w, 502, message(w, "could_not_download_image_b4a293"))
			return
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			res.Body.Close()
			if attempt == 0 && (res.StatusCode == 429 || res.StatusCode >= 500 && res.StatusCode < 600) {
				continue
			}
			writeError(w, 502, message(w, "image_source_http", res.StatusCode))
			return
		}
		data, ext, err := readImageDownload(res.Body)
		res.Body.Close()
		if err != nil {
			var timeout net.Error
			if attempt == 0 && errors.As(err, &timeout) && timeout.Timeout() && r.Context().Err() == nil {
				continue
			}
			if errors.Is(err, vault.ErrTooLarge) {
				vaultError(w, r, err)
			} else if errors.Is(err, errImageType) {
				writeError(w, 422, i18n.RenderError(err, responseLocale(w)))
			} else {
				slog.Error("读取下载图片失败", "err", err)
				writeError(w, 502, message(w, "could_not_read_downloaded_image_4b7fdf"))
			}
			return
		}
		// 下载期间笔记可能被外部程序移动或删除；不能在旧路径下创建孤立资源。
		info, err := s.vault.Stat(note)
		if err != nil {
			vaultError(w, r, err)
			return
		}
		if info.IsDir() {
			writeError(w, 400, message(w, "the_owning_path_must_be_867b53"))
			return
		}
		link, err := s.vault.SaveAsset(note, "image"+ext, bytes.NewReader(data), maxAssetBytes)
		if err != nil {
			vaultError(w, r, err)
			return
		}
		writeJSON(w, 200, map[string]string{"link": link})
		return
	}
}
