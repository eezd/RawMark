# RawMark

纯 Markdown 笔记网页编辑器：所见即所得（类 Obsidian Live Preview）、文件即真源、Docker 部署、浏览器访问。

## 部署

```sh
mkdir -p ~/rawmark-data
docker build -t rawmark .
docker run -d --name rawmark \
  --user "$(id -u):$(id -g)" \
  -p 8080:8080 \
  -v ~/rawmark-data:/data \
  --restart unless-stopped \
  rawmark
```

- 首次打开需要输入启动码，位于数据目录的 `setup-code.txt`（如 `~/rawmark-data/setup-code.txt`），设置密码后自动删除。
- 笔记以普通 `.md` 文件保存在 `数据目录/vault/`，图片按 Typora 习惯存放在同级的 `笔记名.assets/`，可直接用 Typora 等编辑器打开；外部修改会实时同步到网页。
- `--user` 让容器以宿主机用户身份读写数据目录；不指定时容器以 UID 65532 运行，需要该用户对目录有写权限。
- 请通过 HTTPS 反向代理（Caddy、Nginx 等）访问，并转发 WebSocket（`/api/v1/events`）。笔记加密等功能依赖浏览器的安全上下文，纯 HTTP 下不可用。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `RAWMARK_DATA` | `/data` | 数据目录（数据库、默认笔记仓库） |
| `RAWMARK_VAULT` | `$RAWMARK_DATA/vault` | 笔记仓库目录，可指向已有的笔记文件夹 |
| `RAWMARK_ADDR` | `:8080` | 监听地址 |

## 开发

需要 Go 1.27+ 与 Node 24+。开发时不必构建前端或 Docker 镜像，开两个终端：

```sh
# 终端 1：后端（-tags dev 不嵌入前端资源，数据放在仓库下的 .dev-data/）
RAWMARK_DATA=.dev-data RAWMARK_ADDR=127.0.0.1:8080 go run -tags dev ./cmd/rawmark

# 终端 2：前端（热更新，/api 与 WebSocket 转发到 127.0.0.1:8080）
cd web && npm install && npm run dev
```

浏览器打开 http://localhost:5173 ，启动码在 `.dev-data/setup-code.txt`。手机调试用 `npm run dev -- --host`，再访问 `http://<电脑 IP>:5173`。

检查：

```sh
cd web && npm run typecheck && npm test
go vet -tags dev ./... && go test ./internal/...
```
